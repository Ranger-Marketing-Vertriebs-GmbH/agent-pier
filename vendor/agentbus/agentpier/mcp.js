import {context,toolsFor} from './runtime.js';
import {createServer} from '../mcp/server.js';
const ctx=context();
createServer({tools:toolsFor(ctx),name:'agentpier_agentbus',version:'1.0.0'});
