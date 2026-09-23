export const config={api:{bodyParser:false}};
import original from '../handlers/discord-ops.js';
import {createInternalRuntimeHandler} from '../lib/runtime-isolation.js';
export default createInternalRuntimeHandler(original,{runtime:'admin',allowRequest:()=>true});
