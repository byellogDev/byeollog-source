import original from '../handlers/collector-pair.js';
import {createInternalRuntimeHandler} from '../lib/runtime-isolation.js';
export default createInternalRuntimeHandler(original,{runtime:'collector',allowRequest:()=>true});
