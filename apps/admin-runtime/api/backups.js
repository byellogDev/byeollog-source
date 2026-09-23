import original from '../handlers/backups.js';
import {createInternalRuntimeHandler} from '../lib/runtime-isolation.js';
export default createInternalRuntimeHandler(original,{runtime:'admin',allowRequest:()=>true});
