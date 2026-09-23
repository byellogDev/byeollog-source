// Shared presentation helpers. No API requests or application state changes.
(()=>{
 const selector='.eventTaskTable,.previewTable,.statsTable,.legal-page table';
 function enhance(root){
  const tables=[...(root.matches?.(selector)?[root]:[]),...root.querySelectorAll?.(selector)||[]];
  for(const table of tables){
   table.classList.add('readableTable');table.setAttribute('role','table');
   const headers=[...table.querySelectorAll('thead th')].map(th=>th.textContent.trim());
   for(const th of table.querySelectorAll('thead th'))th.setAttribute('scope','col');
   for(const row of table.querySelectorAll('tbody tr')){row.setAttribute('role','row');[...row.cells].forEach((cell,index)=>{cell.setAttribute('role','cell');if(cell.colSpan===1&&headers[index]){cell.dataset.label=headers[index];cell.dataset.compact=String(/^(닉네임|풍선|후원 정보|후원종류|처리상태|현재 학습|추가일|상태|총 별풍선|후원 횟수|후원 건수|후원 인원|날짜)$/.test(headers[index]));}});}
  }
  for(const field of root.querySelectorAll?.('.field')||[]){const label=field.querySelector('label'),input=field.querySelector('input:not([type=hidden]),select,textarea');if(label&&input?.id&&!label.htmlFor)label.htmlFor=input.id;}
 }
 enhance(document);
 // Observe inserted rows, not attributes: updating labels cannot retrigger us.
 const observer=new MutationObserver(records=>{for(const record of records){if(record.target.closest?.('table'))enhance(record.target.closest('table'));else for(const node of record.addedNodes)if(node.nodeType===1)enhance(node);}});
 observer.observe(document.body,{childList:true,subtree:true});
})();
