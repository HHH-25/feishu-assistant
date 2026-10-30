import { BridgeStore, digest } from './store.js';
import { BridgeError, safeError } from './errors.js';
export interface Receipt {
  operation_id:string; owner:string; action:string; fingerprint:string;
  status:'pending'|'success'|'uncertain'; result?:unknown; error?:unknown; updated_at:string;
}
export class Operations {
  constructor(private store:BridgeStore) {}
  previous(owner:string,action:string,key:string,input:unknown) {
    const id=digest([owner,action,key]);
    const previous=this.store.get<Receipt>('operation',id);
    if(previous&&previous.fingerprint!==digest(input)) throw new BridgeError('KEY_CONFLICT','该操作编号已用于不同内容，请使用新的编号',409);
    return previous;
  }
  async run(owner:string,action:string,key:string,input:unknown,work:(checkpoint:(result:unknown)=>void)=>Promise<unknown>) {
    const id=digest([owner,action,key]),fingerprint=digest(input);
    const receipt:Receipt={operation_id:id,owner,action,fingerprint,status:'pending',updated_at:new Date().toISOString()};
    if(!this.store.reserve('operation',id,receipt)) {
      const previous=this.status(owner,id);
      if(previous.fingerprint!==fingerprint) throw new BridgeError('KEY_CONFLICT','该操作编号已用于不同内容，请使用新的编号',409);
      return previous;
    }
    const save=()=>{receipt.updated_at=new Date().toISOString();this.store.put('operation',id,receipt);};
    try {receipt.result=await work(result=>{receipt.result=result;save();});receipt.status='success';}
    catch(error) {receipt.status='uncertain';receipt.error=safeError(error);}
    save();this.store.audit(owner,action,receipt.status);return receipt;
  }
  status(owner:string,id:string) {
    const value=this.store.get<Receipt>('operation',id);
    if(!value||value.owner!==owner) throw new BridgeError('NOT_FOUND','没有找到本人的操作记录',404);
    return value;
  }
  completeVerifiedUpload(owner:string,id:string,result:unknown) {
    const receipt=this.status(owner,id);
    if(!['upload_file','move_existing_document'].includes(receipt.action)||receipt.status!=='uncertain'||
      (receipt.result as {stage?:string}|undefined)?.stage!=='moving')return receipt;
    receipt.status='success';receipt.result=result;delete receipt.error;
    receipt.updated_at=new Date().toISOString();this.store.put('operation',id,receipt);
    this.store.audit(owner,receipt.action==='upload_file'?'verify_upload':'verify_move','success');return receipt;
  }
  completeVerifiedBitable(owner:string,id:string,result:unknown) {
    const receipt=this.status(owner,id);
    if(receipt.action!=='bitable_change'||receipt.status!=='uncertain'||(receipt.result as {stage?:string}|undefined)?.stage!=='accepted')return receipt;
    receipt.status='success';receipt.result=result;delete receipt.error;
    receipt.updated_at=new Date().toISOString();this.store.put('operation',id,receipt);
    this.store.audit(owner,'verify_bitable','success');return receipt;
  }
}
