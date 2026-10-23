// Local/candidate integration only; not loaded by the operating gateway.
// The handoff selector owns duplicate removal. Keep one logical connection and
// monotonic sequence across socket replacement, so two identical real donations
// are not mistaken for replay merely because the socket changed.
import {classifySoopChatSdkCallback,SoopRelevantChatGate} from '../../services/soop-gateway/lib/soop-chat-gateway.js';
import {WorkspaceEventSequencer} from '../../services/soop-gateway/services/soop-chat-gateway/workspace-event-sequencer.mjs';
import {enqueueDurably} from '../../services/soop-gateway/services/soop-chat-gateway/durable-enqueue.mjs';

export function createCandidateDelivery({workspaceId,instanceId,logicalConnectionId,expectedBroadcasterId,leaseToken,outbox}={}){
 for(const value of [workspaceId,instanceId,logicalConnectionId,expectedBroadcasterId,leaseToken])if(typeof value!=='string'||!value.trim())throw Error('delivery_identity_required');
 if(typeof outbox?.enqueue!=='function')throw Error('delivery_outbox_required');
 const queue=new WorkspaceEventSequencer(),chatGate=new SoopRelevantChatGate({windowMs:120000});
 let sequence=0,failure=null;
 return {
  accept(event){
   if(failure)throw Error('delivery_failed');
   const room={bjId:event?.room?.bjId,chatNumber:event?.room?.chatNumber};
   if(room.bjId!==expectedBroadcasterId||!Number.isSafeInteger(room.chatNumber)||room.chatNumber<=0)throw Error('delivery_room_mismatch');
   const result=classifySoopChatSdkCallback({action:event.action,message:event.message,receivedAt:event.receivedAt,
    connection:{id:logicalConnectionId,sequence:sequence++,reconnectCount:0}});
   if(result.kind!=='event')return;
   const value=result.value;
   if(value.relay.eventType==='donation')chatGate.arm(value.relay.event.actor);
   else if(!chatGate.shouldForwardEvent(value,{broadcasterId:expectedBroadcasterId}))return;
   const body={kind:'event',workspaceId,instanceId,leaseToken,room,relay:value.relay,metadata:{action:value.metadata.action,occurredAtSource:value.metadata.occurredAtSource,
    ...(value.metadata.ceremonyImage?{ceremonyImage:value.metadata.ceremonyImage}:{})}};
   // Encrypted outbox + existing per-workspace order and durable-write retry.
   void queue.run(workspaceId,()=>enqueueDurably(outbox,body)).catch(()=>{failure=Error('delivery_enqueue_failed')});
  },
  async drain(){await queue.drain(workspaceId);if(failure)throw failure},
  get pending(){return queue.pendingItems}
 };
}
