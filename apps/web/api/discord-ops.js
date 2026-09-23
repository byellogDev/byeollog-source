export const config={api:{bodyParser:false}};
import {createRuntimeProxyHandler} from '../lib/runtime-proxy.js';
export default createRuntimeProxyHandler({runtime:'admin',endpoint:'/api/discord-ops',rawBody:true});
