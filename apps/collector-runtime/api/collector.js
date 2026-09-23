import original from '../handlers/collector.js';
import {createInternalRuntimeHandler} from '../lib/runtime-isolation.js';
export default createInternalRuntimeHandler(original,{runtime:'collector',allowRequest:()=>true});
