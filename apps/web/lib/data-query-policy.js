// Keep the legacy dashboard wire format, but never forward its query grammar.
const definitions={
 bangsel_tasks:'id fan event type total_qty done_qty memo created_at updated_at added_date fan_soop_id source source_event_key workspace_id public_comment',
 bangsel_fan_stations:'fan station_url updated_at workspace_id',
 bangsel_fans:'soop_id alias current_nickname station_url created_at updated_at workspace_id',
 bangsel_roulette_rules:'result_text action output_types updated_at workspace_id',
 bangsel_donations:'source_event_key source donation_type donated_date donated_time donated_at soop_id nickname balloons message had_roulette roulette_count roulette_results event_name raw_payload imported_at workspace_id',
 bangsel_task_import_items:'source_event_key task_id source created_at workspace_id',
 bangsel_collector_staging:'source_uid session_id broadcast_start_local broadcast_end_local donated_time_text nickname soop_id balloons roulette collector_version raw_payload uploaded_at event_name expected_spins actual_spins validation roulette_results process_status processed_at source_scope processing_started_at process_error process_attempts fixed_rewards workspace_id upbo_retry_protocol upbo_retry_attempts upbo_retry_after',
 bangsel_roulette_invalidations:'source_uid reason invalidated_at workspace_id'
};
const conflicts={bangsel_fan_stations:'workspace_id,fan',bangsel_fans:'workspace_id,soop_id',bangsel_roulette_rules:'workspace_id,result_text',bangsel_donations:'workspace_id,source_event_key',bangsel_task_import_items:'workspace_id,source_event_key',bangsel_collector_staging:'workspace_id,source_scope,source_uid',bangsel_roulette_invalidations:'workspace_id,source_uid'};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export class DataQueryError extends Error{constructor(message='Invalid data request'){super(message);this.status=400}}
const fail=message=>{throw new DataQueryError(message)};
export function buildDataRequest({table,rawPath='',method,workspaceId,body,prefer=''}){
 if(!Object.hasOwn(definitions,table)||!uuid.test(workspaceId))fail();
 if(typeof rawPath!=='string'||rawPath.length>32768||(rawPath&&!rawPath.startsWith('?'))||/[#\u0000-\u001f\u007f]/.test(rawPath)||/%(?![a-f0-9]{2})/i.test(rawPath))fail('Invalid query path');
 const columns=definitions[table].split(' '),allowed=new Set(columns),input=new URLSearchParams(rawPath),out=new URLSearchParams();
 if([...input].length>32)fail('Too many filters');
 const seen=new Set();let filters=0;
 for(const [key,value] of input){
  if(seen.has(key)||key==='workspace_id'||/[\u0000-\u001f\u007f]/.test(value))fail('Invalid query field');seen.add(key);
  if(key==='select'){
   const fields=value==='*'?columns:value.split(',');
   if(!fields.length||fields.some(field=>!allowed.has(field)))fail('Selection not allowed');
   out.set('select',fields.join(','));
  }else if(key==='order'){
   if(value.split(',').length>4||value.split(',').some(term=>{const [field,...parts]=term.split('.');return !allowed.has(field)||parts.length>2||parts.some(part=>!['asc','desc','nullsfirst','nullslast'].includes(part))}))fail('Order not allowed');
   out.set(key,value);
  }else if(key==='limit'||key==='offset'){
   if(method!=='GET'||!/^\d{1,10}$/.test(value)||Number(value)>(key==='limit'?1000:2147483647))fail('Page limit exceeded');out.set(key,String(Number(value)));
  }else if(key==='on_conflict'){
   if(method!=='POST'||value!==conflicts[table])fail('Conflict target not allowed');
  }else{
   if(!allowed.has(key)||key==='workspace_id'||['raw_payload','roulette_results','output_types','fixed_rewards'].includes(key))fail('Filter not allowed');
   const match=/^(eq|neq|gt|gte|lt|lte|is|in|not\.in|not\.eq)\.(.*)$/s.exec(value);
   if(!match||value.length>16384)fail('Filter operator not allowed');
   if(match[1]==='is'&&!['null','true','false'].includes(match[2]))fail('Invalid null filter');
   if(match[1].endsWith('in')&&(!/^\([^()]*\)$/.test(match[2])||match[2].split(',').length>200))fail('Invalid list filter');
   out.append(key,value);filters++;
  }
 }
 if(['PATCH','DELETE'].includes(method)&&filters===0)fail('A row filter is required');
 if(!out.has('select'))out.set('select',columns.join(','));
 if(method==='GET'&&!out.has('limit'))out.set('limit','1000');
 out.set('workspace_id','eq.'+workspaceId);
 const preferences=String(prefer||'return=representation').split(',').map(x=>x.trim());
 if(preferences.length>2||preferences.some(x=>!['return=minimal','return=representation','resolution=merge-duplicates','resolution=ignore-duplicates'].includes(x))||preferences.filter(x=>x.startsWith('return=')).length>1||preferences.filter(x=>x.startsWith('resolution=')).length>1)fail('Preference not allowed');
 if(preferences.some(x=>x.startsWith('resolution='))){if(method!=='POST'||!conflicts[table])fail('Upsert not allowed');out.set('on_conflict',conflicts[table]);}
 let payload;
 if(['POST','PATCH'].includes(method)){
  if(typeof body==='string'){try{body=JSON.parse(body)}catch{fail('Invalid JSON body')}}
  const rows=Array.isArray(body)?body:[body];
  if(!rows.length||rows.length>1000||(method==='PATCH'&&Array.isArray(body)))fail('Invalid write batch');
  payload=rows.map(row=>{
   if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length===0)fail('Invalid row');
   const result={};
   for(const [key,value] of Object.entries(row)){
    if(!allowed.has(key)||(key==='workspace_id'&&value!==workspaceId)||(table==='bangsel_tasks'&&key==='id'))fail('Write field not allowed');
    if(key==='task_id'&&value!==null&&!uuid.test(value))fail('Invalid task reference');
    result[key]=value;
   }
   result.workspace_id=workspaceId;return result;
  });
  if(Buffer.byteLength(JSON.stringify(payload))>2*1024*1024)fail('Write batch too large');
  if(!Array.isArray(body))payload=payload[0];
 }
 return {path:'?'+out.toString(),body:payload,prefer:preferences.join(',')};
}

export async function readBoundedResponse(response,maxBytes=3*1024*1024){
 if(Number(response.headers?.get('content-length')||0)>maxBytes){await response.body?.cancel();throw Error('Response limit exceeded')}
 if(!response.body?.getReader){const text=await response.text();if(Buffer.byteLength(text)>maxBytes)throw Error('Response limit exceeded');return text}
 const reader=response.body.getReader(),chunks=[];let length=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>maxBytes){await reader.cancel();throw Error('Response limit exceeded')}chunks.push(Buffer.from(value))}}finally{reader.releaseLock()}
 return Buffer.concat(chunks).toString('utf8');
}
