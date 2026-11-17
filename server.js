import http from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import mysql from 'mysql2/promise';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 3000);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.ts':'text/plain; charset=utf-8', '.webp':'image/webp' };
const compressible = new Set(['.html','.js','.css','.json','.ts']);
const PRODUCTS = [
  { id:0, name:'تی‌شرت پایه', price:45, colors:['سفید','خاکستری','ذغالی','سرمه‌ای'] },
  { id:1, name:'سویشرت پایه', price:105, colors:['سفید','جو دوسر','مریم‌گلی','مشکی'] },
  { id:2, name:'پیراهن لینن', price:95, colors:['سفید','شنی','آسمانی','زیتونی'] },
  { id:3, name:'هودی خاکستری', price:110, colors:['ملانژ','استخوانی','جنگلی','مشکی'] },
  { id:4, name:'تی‌شرت رینگر', price:55, colors:['سفید / مشکی','کرم / سرمه‌ای','خاکستری / قرمز','سفید / سبز'] }
];
const pool = process.env.DATABASE_URL ? mysql.createPool(process.env.DATABASE_URL) : null;
const schemaReady = pool ? ensureSchema().catch(error => { console.error('schema initialization failed', error.message); throw error; }) : Promise.resolve();

async function ensureSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    id CHAR(36) PRIMARY KEY,
    stripe_session_id VARCHAR(255) NULL UNIQUE,
    stripe_payment_intent_id VARCHAR(255) NULL,
    customer_name VARCHAR(160) NOT NULL,
    customer_email VARCHAR(255) NOT NULL,
    shipping_json TEXT NULL,
    items_json TEXT NOT NULL,
    subtotal_cents INT NOT NULL,
    shipping_cents INT NOT NULL,
    total_cents INT NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'usd',
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stripe_events (
    id VARCHAR(255) PRIMARY KEY,
    type VARCHAR(120) NOT NULL,
    received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  res.end(body);
}
function sendText(res, status, text) { res.writeHead(status, { 'Content-Type':'text/plain; charset=utf-8' }); res.end(text); }
function readBody(req, limit=1024*1024) { return new Promise((resolve,reject)=>{ let size=0; const chunks=[]; req.on('data',chunk=>{size+=chunk.length;if(size>limit){reject(new Error('payload too large'));req.destroy();return}chunks.push(chunk)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject) }) }
async function readJson(req) { const raw=await readBody(req); try{return JSON.parse(raw.toString('utf8')||'{}')}catch{throw new Error('invalid json')} }
function publicOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000').split(',')[0].trim();
  return `${proto}://${host}`;
}
function productById(id){return PRODUCTS.find(product=>product.id===Number(id))}
function normalizeItems(input) {
  if(!Array.isArray(input) || !input.length || input.length>40) throw new Error('سبد خرید خالی است');
  return input.map(raw=>{
    const product=productById(raw.id); if(!product) throw new Error('محصول نامعتبر است');
    const quantity=Math.max(1,Math.min(10,Number(raw.quantity)||1));
    const color=String(raw.color||product.colors[0]).slice(0,80); const size=String(raw.size||'M').slice(0,8);
    if(!product.colors.includes(color)) throw new Error('رنگ نامعتبر است');
    if(!['S','M','L','XL'].includes(size)) throw new Error('سایز نامعتبر است');
    return { id:product.id, name:product.name, price:product.price, quantity, color, size };
  });
}
function totals(items){const subtotalCents=items.reduce((sum,item)=>sum+Math.round(item.price*100)*item.quantity,0);const shippingCents=subtotalCents>=15000?0:990;return {subtotalCents,shippingCents,totalCents:subtotalCents+shippingCents}}
async function insertOrder(order){await schemaReady;await pool.execute(`INSERT INTO orders (id,customer_name,customer_email,shipping_json,items_json,subtotal_cents,shipping_cents,total_cents,status) VALUES (?,?,?,?,?,?,?,?,'pending')`,[order.id,order.customerName,order.customerEmail,JSON.stringify(order.shippingAddress||{}),JSON.stringify(order.items),order.subtotalCents,order.shippingCents,order.totalCents])}
async function updateOrder(id, fields){await schemaReady;const allowed={status:'status',stripeSessionId:'stripe_session_id',stripePaymentIntentId:'stripe_payment_intent_id'};const entries=Object.entries(fields).filter(([key])=>allowed[key]&&fields[key]!==undefined);if(!entries.length)return;const sql=`UPDATE orders SET ${entries.map(([key])=>`${allowed[key]}=?`).join(', ')} WHERE id=?`;await pool.execute(sql,[...entries.map(([,value])=>value),id])}
async function getOrder(id,email){await schemaReady;const [rows]=await pool.execute('SELECT * FROM orders WHERE id=? AND LOWER(customer_email)=LOWER(?) LIMIT 1',[id,String(email||'').trim()]);if(!rows[0])return null;const row=rows[0];return {...row,shippingAddress:JSON.parse(row.shipping_json||'{}'),items:JSON.parse(row.items_json),subtotal:row.subtotal_cents/100,shipping:row.shipping_cents/100,total:row.total_cents/100}}
async function stripeCreateSession(order,req){
  const secret=process.env.STRIPE_SECRET_KEY;if(!secret)throw new Error('پرداخت هنوز پیکربندی نشده است');
  const form=new URLSearchParams();const origin=publicOrigin(req);
  form.set('mode','payment');form.set('success_url',`${origin}/checkout?success=1&session_id={CHECKOUT_SESSION_ID}&order_id=${order.id}`);form.set('cancel_url',`${origin}/checkout?cancelled=1&order_id=${order.id}`);form.set('allow_promotion_codes','true');form.set('client_reference_id',order.id);form.set('metadata[order_id]',order.id);form.set('metadata[customer_name]',order.customerName);form.set('metadata[customer_email]',order.customerEmail);form.set('metadata[shipping_city]',order.shippingAddress?.city||'');form.set('customer_email',order.customerEmail);
  order.items.forEach((item,index)=>{form.set(`line_items[${index}][price_data][currency]`,'usd');form.set(`line_items[${index}][price_data][unit_amount]`,String(Math.round(item.price*100)));form.set(`line_items[${index}][price_data][product_data][name]`,`${item.name} — ${item.color} / ${item.size}`);form.set(`line_items[${index}][quantity]`,String(item.quantity))});
  if(order.shippingCents>0){const index=order.items.length;form.set(`line_items[${index}][price_data][currency]`,'usd');form.set(`line_items[${index}][price_data][unit_amount]`,String(order.shippingCents));form.set(`line_items[${index}][price_data][product_data][name]`,'ارسال استاندارد');form.set(`line_items[${index}][quantity]`,'1')}
  const response=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${secret}:`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:form});
  const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'Stripe Checkout خطا داد');return data;
}
function verifyStripeSignature(raw,header,secret){if(!header||!secret)return false;const parts=header.split(',');const timestamp=parts.find(part=>part.startsWith('t='))?.slice(2);const signatures=parts.filter(part=>part.startsWith('v1=')).map(part=>part.slice(3));if(!timestamp||!signatures.length||Math.abs(Date.now()/1000-Number(timestamp))>300)return false;const expected=createHmac('sha256',secret).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');return signatures.some(signature=>{try{return timingSafeEqual(Buffer.from(expected),Buffer.from(signature))}catch{return false}})}
async function handleCheckout(req,res){try{const payload=await readJson(req);const items=normalizeItems(payload.items);const customerName=String(payload.customerName||'مشتری مارک').trim().slice(0,160);const customerEmail=String(payload.customerEmail||'').trim().toLowerCase().slice(0,255);if(!/^\S+@\S+\.\S+$/.test(customerEmail))throw new Error('ایمیل معتبر وارد کنید');const shippingAddress=payload.shippingAddress&&{city:String(payload.shippingAddress.city||'').trim().slice(0,100),postalCode:String(payload.shippingAddress.postalCode||'').trim().slice(0,30),address:String(payload.shippingAddress.address||'').trim().slice(0,300)};if(!shippingAddress?.city||!shippingAddress?.postalCode||!shippingAddress?.address)throw new Error('اطلاعات ارسال را کامل کنید');const {subtotalCents,shippingCents,totalCents}=totals(items);const order={id:randomUUID(),customerName,customerEmail,shippingAddress,items,subtotalCents,shippingCents,totalCents};await insertOrder(order);try{const session=await stripeCreateSession(order,req);await updateOrder(order.id,{stripeSessionId:session.id});sendJson(res,200,{ok:true,orderId:order.id,checkoutUrl:session.url,totals:{subtotal:subtotalCents/100,shipping:shippingCents/100,total:totalCents/100}})}catch(error){await updateOrder(order.id,{status:'checkout_failed'});throw error}}catch(error){sendJson(res,400,{ok:false,error:error.message||'خطای ناشناخته'})}}
async function handleWebhook(req,res){const raw=await readBody(req,2*1024*1024);if(!verifyStripeSignature(raw,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET))return sendJson(res,400,{error:'invalid signature'});let event;try{event=JSON.parse(raw.toString('utf8'))}catch{return sendJson(res,400,{error:'invalid event'})}await schemaReady;const [result]=await pool.execute('INSERT IGNORE INTO stripe_events (id,type) VALUES (?,?)',[event.id,event.type]);if(result.affectedRows===0)return sendJson(res,200,{received:true,deduplicated:true});const object=event.data?.object||{};const orderId=object.metadata?.order_id||object.client_reference_id;if(event.type==='checkout.session.completed'&&orderId){await updateOrder(orderId,{status:'paid',stripePaymentIntentId:object.payment_intent||null})}else if(event.type==='payment_intent.payment_failed'&&orderId){await updateOrder(orderId,{status:'failed',stripePaymentIntentId:object.id||null})}return sendJson(res,200,{received:true})}
async function handleRequest(req,res){const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);const path=url.pathname;
  if(path==='/api/health')return sendJson(res,200,{ok:true});
  if(path==='/api/cart/checkout'&&req.method==='POST')return handleCheckout(req,res);
  if(path==='/api/stripe/webhook'&&req.method==='POST')return handleWebhook(req,res);
  if(path.startsWith('/api/orders/')&&req.method==='GET'){const email=String(url.searchParams.get('email')||'').trim().toLowerCase();if(!email)return sendJson(res,400,{error:'ایمیل برای پیگیری لازم است'});const order=await getOrder(path.split('/').pop(),email);if(!order)return sendJson(res,404,{error:'سفارش پیدا نشد یا ایمیل مطابقت ندارد'});return sendJson(res,200,{ok:true,order})}
  const requestedFile=path.startsWith('/assets/')?`/public${path}`:path==='/'?'/index.html':path==='/products'||path==='/products/'?'/products.html':path==='/cart'||path==='/cart/'?'/cart.html':path==='/checkout'||path==='/checkout/'?'/checkout.html':path==='/orders'||path==='/orders/'?'/orders.html':path==='/account'||path==='/account/'?'/account.html':path==='/manus-routes.json'?'/public/manus-routes.json':path;
  const safePath=normalize(requestedFile).replace(/^\/{2,}/,'/');const filePath=join(root,safePath);if(!filePath.startsWith(root))return sendText(res,403,'Forbidden');try{const body=await readFile(filePath);const extension=extname(filePath);const headers={'Content-Type':types[extension]||'application/octet-stream','Cache-Control':extension==='.html'?'public, max-age=60, stale-while-revalidate=300':(extension==='.json'?'no-cache':(extension==='.webp'?'public, max-age=31536000, immutable':'public, max-age=3600')),'Vary':'Accept-Encoding'};const acceptsGzip=String(req.headers['accept-encoding']||'').includes('gzip');const shouldCompress=acceptsGzip&&compressible.has(extension);const payload=shouldCompress?gzipSync(body,{level:6}):body;if(shouldCompress)headers['Content-Encoding']='gzip';res.writeHead(200,headers);res.end(payload)}catch{sendText(res,404,'Not found')}}

const server=http.createServer((req,res)=>{handleRequest(req,res).catch(error=>{console.error('request failed',error.message);if(!res.headersSent)sendJson(res,500,{error:'خطای داخلی سرور'})})});
server.listen(port,'0.0.0.0',()=>console.log(`مارک روی پورت ${port} آماده است`));
