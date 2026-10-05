import { TauriStudy } from './tauri-study';
let nextId=1;
const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
const native=(channel:string,...args:unknown[])=>new Promise<any>((resolve,reject)=>{
  const id=nextId++;pending.set(id,{resolve,reject});self.postMessage({kind:'native',id,channel,args});
});
const study=new TauriStudy(native);
self.onmessage=event=>{
  const message=event.data;
  if(message.kind==='native-result') {
    const item=pending.get(message.id);pending.delete(message.id);
    if(message.error!==undefined)item?.reject(new Error(message.error));else item?.resolve(message.value);return;
  }
  void study.request(message.channel,message.args).then(
    value=>self.postMessage({kind:'result',id:message.id,value}),
    error=>self.postMessage({kind:'result',id:message.id,error:String(error)}),
  );
};
