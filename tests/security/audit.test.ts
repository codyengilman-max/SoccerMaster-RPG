import {describe,it,expect} from 'vitest';
import {createCampaign,recordMatch} from '../../src/campaign/campaign';
import {serialize,deserialize,saveCampaign,MemoryStore} from '../../src/save/save';
import {validateEntry} from '../../src/story/ledger';
import {validateResult} from '../../src/minigame/contract';
const make=()=>createCampaign({kind:'boys',player:{name:'Audit',appearance:2,foot:'right',birthMonth:3,position:8},seed:42});
describe('audit regressions',()=>{
 it('round trips a valid save',()=>expect(deserialize(serialize(make(),'a')).campaign).toEqual(make()));
 it('rejects malformed saves',()=>{for(const [key,value] of [['player',null],['progression',-99],['day',-1],['seed',1.2]]){const r=JSON.parse(serialize(make(),'a'));r.campaign[key as string]=value;expect(()=>deserialize(JSON.stringify(r))).toThrow();}});
 it('does not overwrite valid save on invalid candidate',()=>{const s=new MemoryStore();const original=serialize(make(),'a');s.write('a',original);const c=make();(c as any).story=null;expect(()=>saveCampaign(s,'a',c)).toThrow();expect(s.read('a')).toBe(original);});
 it('does not mutate campaign when store rejects write',()=>{const c=make(),before=structuredClone(c);const s=new MemoryStore();s.write=()=>{throw new Error('quota')};expect(()=>saveCampaign(s,'a',c)).toThrow('quota');expect(c).toEqual(before);});
 it('rejects malformed match ledger',()=>expect(validateEntry({id:'x',day:-2,kind:'match',source:'soccer_engine',payload:{eventId:'',fixtureId:'',score:{home:-3,away:'bad'},moments:[null]}})).toBe(false));
 it('rejects malformed minigame result',()=>expect(validateResult({gameId:'world_cup_knockout',episodeId:'e',ageBand:'INVALID',locationId:'x',participantIds:[''],ruleVariant:'x',verifiedActions:[null],outcomeTier:'success',witnessedBehavior:[null],relationshipEffects:[{delta:1e99}],startedAt:-1,resolvedAt:0,exitReason:'completed',seed:1,day:-99,summary:[]})).toBe(false));
 it('rejected match does not mutate any campaign slice',()=>{const c=make(),before=structuredClone(c);expect(recordMatch(c,{eventId:'bad',finished:true,fixtureId:'MISSING',score:{home:1,away:0},home:{clubId:'x'},away:{clubId:'y'}} as any)).toEqual({ok:false,reason:'unknown_fixture'});expect(c).toEqual(before);});
 it('rejects chronology without deleting source save',()=>{const c=make();const e=(id:string,day:number)=>({id,day,kind:'match',source:'soccer_engine',payload:{eventId:id,fixtureId:'f',home:'a',away:'b',role:'CM',score:{home:0,away:0},moments:[]}});c.story.ledger=[e('a',10),e('b',1)] as any;const raw=serialize(c,'a');expect(()=>deserialize(raw)).toThrow('chronology');expect(JSON.parse(raw).campaign.story.ledger).toHaveLength(2);});
});
