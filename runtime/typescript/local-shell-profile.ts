import {existsSync,realpathSync} from "node:fs";
import {homedir} from "node:os";
import {join,resolve,sep} from "node:path";

const canonical = (path:string) => existsSync(path) ? realpathSync(path) : resolve(path);
const subpath = (path:string) => "(subpath " + JSON.stringify(path) + ")";

function privateRoots(home:string,data:string) {
  return new Set([canonical(home),canonical(data),canonical(join(homedir(),".lake")),canonical(join(homedir(),".lake-dev"))]);
}

export function overlapsPrivateStorage(home:string,data:string,workspace:string,path:string) {
  const activeHome=canonical(home), activeData=canonical(data);
  const managed=workspace.startsWith(join(activeHome,"workspaces")+sep);
  const contains=(parent:string,child:string)=>parent===child || child.startsWith(parent+sep);
  for (const root of privateRoots(home,data)) {
    if (!contains(root,path) && !contains(path,root)) continue;
    if (managed && contains(workspace,path) && contains(root,workspace) &&
        (root!==activeData || activeData===activeHome)) continue;
    return true;
  }
  return false;
}

// The runtime record in data contains the desktop's control credential. The
// data directory can be outside home. An overlapping project path must never
// turn that directory into an allowed subtree of the sandbox.
export function localShellProfile(home:string,data:string,workspace:string,projectId:string,sessionId:string) {
  const activeHome = canonical(home), activeData = canonical(data);
  const output = join(activeData,"tool-output",sessionId);
  const ownWorkspace = join(activeHome,"workspaces",projectId);
  const rules = Array.from(privateRoots(home,data),root => {
    const exceptions:string[] = [];
    if (output.startsWith(root+sep)) exceptions.push(output);
    if (canonical(workspace) === ownWorkspace && ownWorkspace.startsWith(root+sep) &&
        (root !== activeData || root === activeHome)) exceptions.push(ownWorkspace);
    const filter = exceptions.length ? "(require-all " + subpath(root) + " " +
      exceptions.map(path => "(require-not " + subpath(path) + ")").join(" ") + ")" : subpath(root);
    return "(deny file-read* file-write* " + filter + ")";
  });
  const credentials = [join(homedir(),".ssh"),join(homedir(),"Library/Keychains"),"/Library/Keychains"].map(canonical);
  return "(version 1)(allow default)" + rules.join("") +
    "(deny file-read* file-write* " + credentials.map(subpath).join(" ") +
    ")(deny process-exec (literal \"/usr/bin/security\"))";
}
