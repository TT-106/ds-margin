import { describe,expect,it } from 'vitest';
import { conversationId,DEFAULT_SETTINGS,fillTemplate,fingerprint,mergeSnapshot,normalizeSettings,searchLibrary,variables,type Conversation,type Backup } from '../src/shared/model';
import { readBackup } from '../src/shared/validation';
import { toMarkdown } from '../src/shared/export';
export function sample(id='test-chat-001'):Conversation {
  return {id,url:`https://chat.deepseek.com/a/chat/s/${id}`,title:'关于留白的讨论',messages:[{id:'1',role:'user',text:'如何设计阅读界面？',markdown:'如何设计阅读界面？',fingerprint:fingerprint('如何设计阅读界面？')}],capturedAt:1000,scope:'observed',pinned:false,folder:'',tags:[]};
}
function backup():Backup {return {format:'ds-margin',version:1,exportedAt:1000,settings:DEFAULT_SETTINGS,conversations:[sample()],bookmarks:[],prompts:[],drafts:[],blocked:[]};}
describe('identity and settings',()=>{
  it('accepts only first party chat paths and rejects login / forged origins',()=>{
    expect(conversationId('https://chat.deepseek.com/a/chat/s/test-chat-001#fragment')).toBe('test-chat-001');
    for(const url of ['https://chat.deepseek.com.evil.org/a/chat/s/test-chat-001','javascript:alert(1)','https://chat.deepseek.com/sign_in','https://chat.deepseek.com/a/chat/s/test-chat-001/more'])expect(conversationId(url)).toBeNull();
  });
  it('clamps corrupted imported settings and never accepts strings as numeric CSS',()=>{
    const s=normalizeSettings({fontSize:'100px;background:red',contentWidth:999999,lineHeight:NaN,theme:'neon'});
    expect(s.fontSize).toBe(16);expect(s.contentWidth).toBe(1200);expect(s.lineHeight).toBe(1.85);expect(s.theme).toBe('system');
  });
});
describe('virtual lists and local search',()=>{
  it('keeps messages that scroll out of the DOM and updates stable IDs without duplicating',()=>{
    const old=sample();old.folder='学习';old.tags=['界面'];old.pinned=true;
    const next=sample();next.messages=[{...old.messages[0],id:'2',text:'新的回答',fingerprint:fingerprint('新的回答')}];
    const merged=mergeSnapshot(old,next);
    expect(merged.messages.map(m=>m.id)).toEqual(['1','2']);expect(merged.folder).toBe('学习');expect(merged.pinned).toBe(true);
    const edited={...next,messages:[{...next.messages[0],text:'修改后的回答'}]};
    expect(mergeSnapshot(merged,edited).messages).toHaveLength(2);expect(mergeSnapshot(merged,edited).messages[1].text).toBe('修改后的回答');
  });
  it('requires all search terms across title, tags and body',()=>{
    const c=sample();c.tags=['设计'];
    expect(searchLibrary([c],'设计 界面')).toHaveLength(1);expect(searchLibrary([c],'设计 不存在')).toHaveLength(0);
  });
});
describe('templates and export',()=>{
  it('treats replacement text literally and does not recursively expand input',()=>{
    expect(variables('解释 {{ 概念 }}，再解释 {{概念}}')).toEqual(['概念']);
    expect(fillTemplate('{{文本}}',{'文本':'$& {{另一个变量}}'})).toBe('$& {{另一个变量}}');
    expect(fillTemplate('{{缺少值}}',{})).toBe('{{缺少值}}');
  });
  it('marks exported coverage and preserves content',()=>{
    const c=sample();c.messages[0].markdown='```python\nprint(1)\n```';
    expect(toMarkdown(c)).toContain('不代表完整历史');expect(toMarkdown(c)).toContain('print(1)');
  });
});
describe('backup boundary',()=>{
  it('round-trips a supported backup and strips untrusted additional fields',()=>{
    const value={...backup(),cookies:'must not import'};
    expect(readBackup(value)).not.toHaveProperty('cookies');expect(readBackup(value).conversations[0].id).toBe('test-chat-001');
  });
  it('rejects the whole file before writes if one record is invalid',()=>{
    const bad=backup();bad.conversations.push({...sample(),url:'https://evil.org/chat/fake'});
    expect(()=>readBackup(bad)).toThrow();expect(()=>readBackup({...backup(),version:5})).toThrow('版本');
    expect(()=>readBackup({...backup(),drafts:[{id:'../wrong',text:'x',updatedAt:1}]})).toThrow();
  });
  it('validates v3 side-question anchors and preserves the recorded phase for safe import',()=>{
    const parent=sample();
    const anchor={messageId:'1',fingerprint:parent.messages[0].fingerprint,quote:'阅读界面',start:4,end:8};
    const turn={id:'turn-1',question:'怎样设置字号？',status:'pending',checkpoint:{phase:'sending'},createdAt:1000,updatedAt:1001};
    const thread={id:'thread-1',parentId:parent.id,parentUrl:parent.url,parentTitle:parent.title,anchor,turns:[turn],createdAt:1000,updatedAt:1001};
    const value={...backup(),version:3,sideQuestions:[thread],jobs:[{id:'legacy-job'}],artifacts:[{id:'legacy-result'}],novels:[{id:'legacy-novel'}]};
    expect(readBackup(value)).toEqual({...backup(),version:3,sideQuestions:[thread]});
    expect(()=>readBackup({...value,sideQuestions:[{...thread,anchor:{...anchor,end:anchor.start}}]})).toThrow('选区为空');
    expect(()=>readBackup({...value,sideQuestions:[{...thread,nativeUrl:parent.url}]})).toThrow('关联无效');
  });
  it('keeps supported v2 records when a backup contains legacy task data',()=>{
    const value={...backup(),version:2,jobs:[{id:'legacy-job'}],artifacts:[{id:'legacy-result'}],novels:[{id:'legacy-novel'}]};
    expect(readBackup(value)).toEqual({...backup(),version:2});
  });
});
