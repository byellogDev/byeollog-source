export class WorkspaceEventSequencer{
  constructor(){this.tails=new Map();this.pending=new Map();this.sequence=0}

  run(workspaceId,work){
    const key=String(workspaceId||'').trim();
    if(!key||typeof work!=='function'){
      return Promise.reject(new TypeError('Workspace event work is invalid'));
    }
    const previous=this.tails.get(key)||Promise.resolve(),ticket=++this.sequence;
    this.pending.set(ticket,Date.now());
    const current=previous.catch(()=>{}).then(work).finally(()=>this.pending.delete(ticket));
    const tail=current.catch(()=>{});
    this.tails.set(key,tail);
    void tail.finally(()=>{if(this.tails.get(key)===tail)this.tails.delete(key)});
    return current;
  }

  async drain(workspaceId=null){
    const key=workspaceId===null?null:String(workspaceId||'').trim();
    if(key){
      while(true){
        const tail=this.tails.get(key);
        if(!tail)return;
        await tail;
        if(this.tails.get(key)===tail)this.tails.delete(key);
      }
    }
    while(this.tails.size){
      const snapshot=[...this.tails.entries()];
      await Promise.all(snapshot.map(([,tail])=>tail));
      for(const [entryKey,tail] of snapshot){
        if(this.tails.get(entryKey)===tail)this.tails.delete(entryKey);
      }
    }
  }

  get pendingWorkspaces(){return this.tails.size}
  get pendingItems(){return this.pending.size}
  get oldestAgeMs(){const first=this.pending.values().next();return first.done?0:Math.max(0,Date.now()-first.value)}
}
