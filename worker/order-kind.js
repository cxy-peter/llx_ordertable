// Accounting classification is independent of authentication permissions.
// Only a merchant can change it; never trust a customer-supplied flag.
export function orderScope(url, alias='') {
 const scope=url.searchParams.get('scope')||'real';
 if(!['real','test'].includes(scope))throw Object.assign(new Error('请选择真实订单或测试订单'),{name:'OrderKindError',status:400});
 return {scope,isTest:scope==='test'?1:0,sql:`${alias}is_test=${scope==='test'?1:0}`};
}
