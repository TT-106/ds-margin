import 'fake-indexeddb/auto';
import { describe,expect,it } from 'vitest';
import { Database } from '../src/background/database';
import { fingerprint,type Conversation } from '../src/shared/model';
function conversation():Conversation{return {id:'test-db-chat',url:'https://chat.deepseek.com/a/chat/s/test-db-chat',title:'数据库测试',messages:[{id:'1',role:'user',text:'问题',markdown:'问题',fingerprint:fingerprint('问题')}],capturedAt:1,scope:'observed',pinned:false,folder:'',tags:[]};}
describe('persisted archive lifecycle',()=>{
  it('persists across a new connection and pauses re-collection after deletion',async()=>{
    const name=`test-${crypto.randomUUID()}`,db=new Database(name),c=conversation();
    expect(await db.archive(c)).toBe(true);
    const reopened=new Database(name);expect((await reopened.get<Conversation>('conversations',c.id))?.messages[0].text).toBe('问题');
    await reopened.removeConversation(c.id);expect(await db.archive({...c,capturedAt:2})).toBe(false);
    expect(await db.all('conversations')).toHaveLength(0);
    await db.batch([{store:'blocked',remove:c.id}]);expect(await db.archive(c)).toBe(true);
  });
  it('merges observed windows without resetting local organization',async()=>{
    const db=new Database(`test-${crypto.randomUUID()}`),c=conversation();c.folder='项目';c.pinned=true;
    await db.archive(c);await db.archive({...c,folder:'',pinned:false,messages:[{...c.messages[0],id:'2',text:'回答'}]});
    const stored=await db.get<Conversation>('conversations',c.id);expect(stored?.messages).toHaveLength(2);expect(stored?.pinned).toBe(true);expect(stored?.folder).toBe('项目');
  });
});
