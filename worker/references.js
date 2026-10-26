// Display identifiers never replace the internal ID or the ownership check.
export function orderReference(o,admin=false){
 const customer='C'+String(o.customer_code||0).padStart(6,'0');
 const sequence=String(o.customer_sequence||1).padStart(3,'0');
 const code=String(o.day_sequence||o.id).padStart(4,'0');
 const date=o.date.replaceAll('-','');
 const timestamp=(o.order_created_at||o.created_at||o.date+'T00:00:00Z').replace(/[-:.TZ]/g,'').slice(0,14);
 const merchant=`${customer}-${date}-${sequence}-${code}`;
 const history=`${customer}-${timestamp}-${sequence}-${code}`;
 return {number:admin?merchant:history,customer_number:history,merchant_number:merchant,customer_code:customer,customer_sequence:o.customer_sequence||1,check_code:code};
}
