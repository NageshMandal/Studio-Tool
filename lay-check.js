const path=require('path'),ejs=require('ejs');
const {icon}=require('./utils/icons');
const {capabilities}=require('./middleware/auth');
const {formatWhen,formatTime,formatDuration,formatSince,formatDay}=require('./utils/format');
const VIEWS=path.join(__dirname,'views');
const studio={_id:'s1',name:'Patna',code:'PAT',theme:'green',status:'active'};
const studios=[studio];
const roles={
 super:{id:'root',name:'Studio Admin',email:'a@o.com',adminRole:'super',isRoot:true,location:null},
 location_admin:{id:'a1',name:'Priya',email:'p@o.com',adminRole:'location_admin',location:'s1'},
 location_manager:{id:'a2',name:'Sujit',email:'s@o.com',adminRole:'location_manager',location:'s1'}};
let fail=0;
const go=(v,l,label)=>new Promise(r=>ejs.renderFile(path.join(VIEWS,v+'.ejs'),l,{views:[VIEWS]},(e)=>{
 if(e){fail++;console.log('FAIL '+label+'\n     '+String(e.message).split('\n').filter(Boolean).pop().trim());}
 else console.log('PASS '+label); r();}));
(async()=>{
 const base=(role,active)=>({admin:roles[role],can:capabilities(roles[role]),activeStudio:active,studios,
  active:'dashboard',title:'T',subtitle:'sub',body:'<p>x</p>',message:'hi',pendingRequestCount:3,pendingPurchaseCount:2,
  icon,formatWhen,formatTime,formatDuration,formatSince,formatDay,
  formatDate:d=>'d',formatMoney:n=>'0'});
 for(const role of Object.keys(roles)){
  await go('layout',base(role,studio),`layout           ${role} (studio selected)`);
  await go('layout',base(role,null),`layout           ${role} (no studio)`);
  await go('partials/sidebar',base(role,studio),`sidebar          ${role}`);
 }
 await go('shell-layout',base('super',null),'shell-layout     super');
 await go('auth-layout',{title:'T',body:'<p>x</p>'},'auth-layout');
 await go('staff/layout',{staff:{name:'Rahul',accountType:'power',email:'r@o.com'},studio,title:'T',
   body:'<p>x</p>',active:'',unreadAlertCount:1,message:null,error:null,icon},'staff/layout');
 await go('partials/staff-sidebar',{studio,active:'',unreadAlertCount:1,icon,
   staff:{name:'Rahul'}},'staff-sidebar');
 console.log(fail?`\n${fail} failed`:'\nALL LAYOUTS RENDER CLEANLY');
 process.exit(fail?1:0);})();
