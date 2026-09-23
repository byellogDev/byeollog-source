import {createRuntimeProxyHandler} from '../lib/runtime-proxy.js';
import {selectDataRuntime} from '../lib/runtime-isolation.js';
export default createRuntimeProxyHandler({chooseRuntime:selectDataRuntime,endpoint:'/api/data'});
