import original from '../handlers/data.js';
import {createInternalRuntimeHandler,allowPublicData} from '../lib/runtime-isolation.js';
export default createInternalRuntimeHandler(original,{runtime:'public',allowRequest:allowPublicData});
