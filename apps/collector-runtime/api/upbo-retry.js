import original from '../handlers/upbo-retry.js';
import {createInternalRuntimeHandler} from '../lib/runtime-isolation.js';
export default createInternalRuntimeHandler(original,{runtime:'collector',allowRequest:()=>true});
