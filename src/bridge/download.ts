import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, request } from 'undici';
import { BridgeError } from './errors.js';
export const MAX_ATTACHMENT = 20 * 1024 * 1024;
const blocked = new BlockList();
for (const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) blocked.addSubnet(ip,bits,'ipv4');
const global6 = new BlockList();global6.addSubnet('2000::',3,'ipv6');
const denied6 = new BlockList();denied6.addSubnet('2001::',23,'ipv6');denied6.addSubnet('2001:db8::',32,'ipv6');denied6.addSubnet('2002::',16,'ipv6');
export function publicAddress(ip: string) {
  return isIP(ip)===4 ? !blocked.check(ip,'ipv4') :
    isIP(ip)===6 && global6.check(ip,'ipv6') && !denied6.check(ip,'ipv6');
}
export async function downloadAttachment(input: string): Promise<Buffer> {
  let url = new URL(input);
  for(let redirects=0;redirects<=3;redirects++) {
    if(url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443'))
      throw new BridgeError('BAD_DOWNLOAD','附件必须使用公开 HTTPS 下载地址');
    const hostname=url.hostname.replace(/^\[|\]$/g,'');
    const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await lookup(hostname,{all:true});
    if(!addresses.length||addresses.some(a=>!publicAddress(a.address))) throw new BridgeError('BAD_DOWNLOAD','附件下载地址不可访问');
    // Pin the validated DNS answer in the actual socket connection (including redirects).
    const dispatcher=new Agent({connect:{lookup:(_host,options,callback)=>{
      const chosen=addresses[0];
      if(options.all) callback(null,addresses);else callback(null,chosen.address,chosen.family);
    }}});
    try {
      const response=await request(url,{dispatcher,headersTimeout:15000,bodyTimeout:20000,
        signal:AbortSignal.timeout(45000)});
      if([301,302,303,307,308].includes(response.statusCode)) {
        const location=response.headers.location;response.body.destroy();
        if(typeof location!=='string'||redirects===3) throw new BridgeError('BAD_DOWNLOAD','附件跳转次数过多');
        url=new URL(location,url);continue;
      }
      if(response.statusCode!==200) {response.body.destroy();throw new BridgeError('DOWNLOAD_FAILED','附件链接已失效，请重新选择文件');}
      if(Number(response.headers['content-length'])>MAX_ATTACHMENT) {response.body.destroy();throw new BridgeError('TOO_LARGE','附件超过 20 MiB');}
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of response.body) {
        const buffer=Buffer.from(chunk);size+=buffer.length;
        if(size>MAX_ATTACHMENT) {response.body.destroy();throw new BridgeError('TOO_LARGE','附件超过 20 MiB');}
        chunks.push(buffer);
      }
      if(!size) throw new BridgeError('EMPTY_FILE','不能上传空附件');
      return Buffer.concat(chunks);
    } finally {await dispatcher.close();}
  }
  throw new BridgeError('BAD_DOWNLOAD','附件下载失败');
}
