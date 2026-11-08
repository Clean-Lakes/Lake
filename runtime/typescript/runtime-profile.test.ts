import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRuntimeProfile} from './runtime-profile';

const homes={production:'/synthetic-user/.lake',development:'/synthetic-user/.lake-dev'};
const paths=(home:string)=>({home,data:home+'/web-agent'});
test('distribution profiles admit their own Home while candidates remain isolated',()=>{
 assert.doesNotThrow(()=>validateRuntimeProfile({...paths(homes.production),production:true},homes));
 assert.doesNotThrow(()=>validateRuntimeProfile({...paths(homes.development),development:true},homes));
 assert.doesNotThrow(()=>validateRuntimeProfile(paths('/tmp/isolated'),homes));
 for(const home of Object.values(homes))assert.throws(()=>validateRuntimeProfile(paths(home),homes),/独立 Home/);
});
test('a production opt-in cannot access Dev or mixed protected directories',()=>{
 for(const options of [
  {...paths(homes.development),production:true}, {...paths(homes.production),development:true},
  {...paths(homes.production),production:true,development:true},
  {home:homes.production,data:homes.development+'/web-agent',production:true},
  {home:'/tmp/isolated',data:homes.production+'/web-agent',production:true},
  {home:homes.production+'/nested',data:homes.production+'/nested/web-agent',production:true},
  {home:homes.production,data:homes.production,production:true},
 ])assert.throws(()=>validateRuntimeProfile(options,homes));
});
