const MARK_CART_KEY='mark-cart-v1';
const MARK_PRODUCTS=[
  {id:0,name:'تی‌شرت پایه',price:45,colors:['سفید','خاکستری','ذغالی','سرمه‌ای']},
  {id:1,name:'سویشرت پایه',price:105,colors:['سفید','جو دوسر','مریم‌گلی','مشکی']},
  {id:2,name:'پیراهن لینن',price:95,colors:['سفید','شنی','آسمانی','زیتونی']},
  {id:3,name:'هودی خاکستری',price:110,colors:['ملانژ','استخوانی','جنگلی','مشکی']},
  {id:4,name:'تی‌شرت رینگر',price:55,colors:['سفید / مشکی','کرم / سرمه‌ای','خاکستری / قرمز','سفید / سبز']}
];
const MARK_GARMENT_POS=[[1.14,3.06],[49.7,1.39],[98.2,3.33],[1.14,93.3],[49.7,95.3]];
function markReadCart(){try{return JSON.parse(localStorage.getItem(MARK_CART_KEY)||'[]')}catch{return []}}
function markWriteCart(items){localStorage.setItem(MARK_CART_KEY,JSON.stringify(items));window.dispatchEvent(new CustomEvent('mark-cart-updated'))}
function markAddToCart(item){const items=markReadCart();const key=`${item.id}-${item.size||'M'}-${item.color||item.colors?.[0]||''}`;const existing=items.find(x=>x.key===key);if(existing)existing.quantity=Math.min(10,existing.quantity+Number(item.quantity||1));else items.push({key,id:Number(item.id),size:item.size||'M',color:item.color||item.colors?.[0]||'',quantity:Number(item.quantity||1)});markWriteCart(items);return items}
function markRemoveFromCart(key){markWriteCart(markReadCart().filter(item=>item.key!==key))}
function markUpdateQuantity(key,quantity){const items=markReadCart();const item=items.find(x=>x.key===key);if(item)item.quantity=Math.max(1,Math.min(10,Number(quantity)||1));markWriteCart(items)}
function markCartCount(){return markReadCart().reduce((sum,item)=>sum+Number(item.quantity||0),0)}
function markFormatMoney(value){return `$${Number(value).toFixed(2)}`}
function markSyncCartBadges(){document.querySelectorAll('[data-cart-count]').forEach(el=>{const count=markCartCount();el.textContent=count?String(count):'';el.hidden=!count})}
window.MARK_PRODUCTS=MARK_PRODUCTS;window.MARK_GARMENT_POS=MARK_GARMENT_POS;window.markReadCart=markReadCart;window.markWriteCart=markWriteCart;window.markAddToCart=markAddToCart;window.markRemoveFromCart=markRemoveFromCart;window.markUpdateQuantity=markUpdateQuantity;window.markCartCount=markCartCount;window.markFormatMoney=markFormatMoney;window.markSyncCartBadges=markSyncCartBadges;markSyncCartBadges();window.addEventListener('mark-cart-updated',markSyncCartBadges);
