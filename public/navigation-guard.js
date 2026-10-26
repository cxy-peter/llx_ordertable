let navigationPrompt=null;
async function navigationCheck(){
 if(navigationPrompt)return false;
 try{await api('/api/navigation',{method:'POST',body:{}});return true}
 catch(e){if(e.status!==428||!e.challenge)throw e;return showNavigationChallenge(e.challenge)}
}
function showNavigationChallenge(challenge){
 if(navigationPrompt)return navigationPrompt;
 let finish;navigationPrompt=new Promise(resolve=>finish=resolve);
 const dialog=document.createElement('dialog');dialog.className='risk-dialog';dialog.setAttribute('aria-labelledby','risk-title');
 dialog.innerHTML='<form id="navigation-verification"><h2 id="risk-title">操作有点快，请验证一下</h2><p>请完成计算题后继续。餐袋和已保存的订单都会保留。</p><label class="field"><span id="risk-question"></span><input name="answer" inputmode="numeric" pattern="[0-9]{1,4}" maxlength="4" required autocomplete="off" aria-label="计算题答案"></label><p id="risk-error" role="alert"></p><div class="actions"><button class="btn" type="submit">验证并继续</button><button class="btn outline" type="button" data-risk-cancel>稍后再试</button></div></form>';
 let current=challenge;const question=dialog.querySelector('#risk-question'),error=dialog.querySelector('#risk-error');question.textContent=current.question;
 function end(ok){dialog.close();dialog.remove();navigationPrompt=null;finish(ok)}
 dialog.addEventListener('cancel',e=>{e.preventDefault();end(false)});
 dialog.querySelector('[data-risk-cancel]').addEventListener('click',()=>end(false));
 dialog.addEventListener('submit',async e=>{
  e.preventDefault();e.stopImmediatePropagation();const button=dialog.querySelector('[type="submit"]');button.disabled=true;
  try{await api('/api/navigation/verify',{method:'POST',body:{challenge_id:current.id,answer:dialog.querySelector('input').value}});end(true)}
  catch(e){if(e.challenge){current=e.challenge;question.textContent=current.question}error.textContent=e.status===428?'答案不正确或已过期，请重新计算。':e.message;dialog.querySelector('input').value='';dialog.querySelector('input').focus()}
  finally{button.disabled=false}
 },true);
 document.body.append(dialog);dialog.showModal();dialog.querySelector('input').focus();return navigationPrompt;
}
