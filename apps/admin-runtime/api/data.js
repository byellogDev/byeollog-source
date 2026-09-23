import original from '../handlers/data.js';
import {createInternalRuntimeHandler,allowAdminData} from '../lib/runtime-isolation.js';
export default createInternalRuntimeHandler(original,{runtime:'admin',allowRequest:allowAdminData});
