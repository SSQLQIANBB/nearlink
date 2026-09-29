from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import json,html
ROOT=Path(__file__).parent; OUT=ROOT/'png'; S=2
BG='#F4F7FA'; INK='#152B3B'; MUT='#6C7E8C'; GREEN='#009C7B'; LINE='#DCE5EB'; WHITE='#FFFFFF'; NAV='#102735'
font='/System/Library/Fonts/Hiragino Sans GB.ttc'
def txt(x,y,s,size=18,c=INK):
 d.text((int(x*S),int(y*S)),s,font=ImageFont.truetype(font,int(size*S)),fill=c)
def box(x,y,w,h,c=WHITE,r=16,stroke=None):
 d.rounded_rectangle((x*S,y*S,(x+w)*S,(y+h)*S),radius=r*S,fill=c,outline=stroke,width=S)
def line(x,y,x2,y2,c=LINE): d.line((x*S,y*S,x2*S,y2*S),fill=c,width=2*S)
def button(x,y,label,w=150,kind='primary',target=None):
 col=GREEN if kind=='primary' else '#FFF0EF' if kind=='danger' else '#E9F2F1'
 box(x,y,w,44,col,10);txt(x+16,y+10,label,16,WHITE if kind=='primary' else '#B44740' if kind=='danger' else GREEN)
 if target is not None: links.append(dict(x=x,y=y,w=w,h=44,target=target,label=label))
def pill(x,y,label,c=GREEN):
 box(x,y,len(label)*13+25,28,'#E4F4EE' if c==GREEN else '#FFF1DB',14);txt(x+12,y+5,label,12,c)
def base(num,title,subtitle,note,nav='远程控制'):
 global im,d,links
 im=Image.new('RGB',(1440*S,1000*S),BG);d=ImageDraw.Draw(im);links=[]
 box(0,0,212,910,NAV,0);txt(28,30,'ToDesk',30,WHITE);txt(28,78,'远程协作 · 内测版',13,'#A9C1CE')
 for i,(s,t) in enumerate([('消息',1),('远程控制',1),('我的设备',10),('文件传输',11),('设置',2)]):
  y=156+i*62
  if s==nav:box(16,y-8,180,48,'#1C514D',10)
  txt(35,y,s,17,WHITE if s==nav else '#A9C1CE');links.append(dict(x=16,y=y-8,w=180,h=48,target=t,label=s))
 txt(28,816,'连接，让协作更近',13,'#A9C1CE');txt(28,855,'林同学  /  个人工作区',13,'#A9C1CE')
 box(212,0,1228,74,WHITE,0);txt(252,24,'工作区  /  '+nav,16,MUT);pill(1150,22,'交互设计稿');txt(1320,26,f'{num:02d} / 11',13,MUT)
 txt(252,104,title,32);txt(252,156,subtitle,16,MUT)
 box(0,910,1440,90,NAV,0);txt(28,930,f'{num:02d}  ·  交互说明',15,'#67D7BC');txt(205,930,note,15,WHITE);txt(205,961,'设计基线：0.5.0-beta.13 源码；能力依检测与验收开放。所有人物、设备和指标均为示例。',12,'#A9C1CE')
def save(n,name):
 f=f'{n:02d}-{name}.png';im.save(OUT/f);pages.append(dict(file=f,title=name,links=links.copy()))
def row(x,y,title,desc,action=None,target=None):
 box(x,y,1096,90);txt(x+24,y+18,title,19);txt(x+24,y+50,desc,14,MUT)
 if action:button(x+886,y+23,action,184,'secondary',target)
def desktop():
 box(252,273,1136,487,'#DCEBEA',14);box(285,305,720,395,WHITE,12);box(285,305,720,40,'#ECF2F5',12)
 txt(310,317,'项目资料  /  协作示例',13,MUT);txt(322,377,'团队周报',26);txt(322,428,'本周完成',18)
 for i,t in enumerate(['完成远程协助交互梳理','核对产品与系统授权边界','准备跨电脑键鼠验收']): txt(340,477+i*47,'•  '+t,17,MUT)
 box(1050,338,278,232,'#F5FAF7',14);txt(1075,365,'协作便签',20);txt(1075,410,'确认完成后请结束协助',16,MUT);txt(1075,449,'资料与桌面仅为示例',15,MUT)
 box(582,712,470,34,'#BDD4D0',12)
pages=[]
base(0,'远程协助 · 交互全景','先明确谁控制谁，再按实际能力进入协助。','点击本地原型中的流程卡片可跳转；蓝湖图片中的编号对应页面。')
for i,(a,b,c,t) in enumerate([('01  选择设备','Web / 桌面均可发起','选择查看或控制',1),('04  等待同意','展示请求范围与等待状态','可取消，失败可重试',4),('05  本机授权','本机选择查看 / 控制 / 拒绝','记住允许默认不勾选',5),('06–07  远程协作','状态常驻，随时结束','查看与控制明确区分',7)]):
 x=252+i*286;box(x,239,262,202);txt(x+20,264,a,21);txt(x+20,312,b,15,MUT);txt(x+20,344,c,14,MUT);button(x+20,382,'查看界面',140,'secondary',t)
for i,(a,b,t) in enumerate([('02  权限准备','仅桌面被控端；缺引擎不能误导为缺权限',2),('03  协助许可','临时或长期；与是否记住允许分开',3),('08  异常恢复','暂停输入与会话结束分开呈现',8),('09  结束协助','明确停止画面和键鼠；不自动再次连接',9)]):
 x=252+(i%2)*572;y=478+(i//2)*155;box(x,y,548,131);txt(x+20,y+20,a,21);txt(x+20,y+60,b,14,MUT);button(x+392,y+77,'打开',130,'secondary',t)
box(252,816,1120,56,'#E4F4EE');txt(272,834,'近期：连接与授权 / 会话稳定性       后续：文件与剪贴板 / 多屏 / 运维 / 外设 / 企业协作',17,GREEN);save(0,'交互全景')
base(1,'连接你的工作现场','选择已获协助许可的设备，发起一次远程连接。','请求按钮按在线、占用及实际查看/控制能力启用；Web 不展示本机上线开关。')
box(252,214,1136,84,'#E4F4EE');txt(276,235,'Web 主控已就绪',20,GREEN);txt(276,268,'可查看或控制已授权的桌面设备。需要被控时，请使用具备被控引擎的客户端。',15,GREEN)
box(252,325,738,365);txt(277,350,'可协助的设备',23);txt(277,398,'设备名称                         状态                         可用能力',14,MUT)
line(277,433,963,433);txt(277,460,'设计工作站',22);pill(597,458,'在线');txt(720,462,'查看 · 键鼠',15,MUT)
button(277,512,'请求观看',150,'secondary',4);button(445,512,'请求控制',150,'primary',4)
line(277,587,963,587);txt(277,616,'办公室电脑',20);txt(597,619,'离线',16,MUT);txt(720,619,'上线后可连接',15,MUT)
box(1014,325,374,365);txt(1040,350,'让对方协助我',23);txt(1040,403,'桌面客户端专属',16,GREEN);txt(1040,453,'1. 完成本机权限检测',16,MUT);txt(1040,491,'2. 选择可协助你的联系人',16,MUT);txt(1040,529,'3. 开启本机协助',16,MUT);button(1040,601,'查看权限准备',250,'secondary',2)
row(252,724,'没有找到设备？','对方需要上线，并为你的账号开启协助许可。','管理我的设备',10);save(1,'连接工作台')
base(2,'准备本机远程协助','桌面客户端 · macOS · 当前设备：设计工作站','先查引擎及平台，再查系统权限。通用包缺引擎时禁用上线；权限由用户在系统完成。',nav='设置')
for y,t,s,b in [(224,'01  被控引擎','此示例为带引擎的 macOS 测试客户端；正式入口仍需平台验收。','检测通过'),(338,'02  屏幕录制','允许对方查看你的屏幕；开启后可能需要重新启动 ToDesk。','已开启'),(452,'03  辅助功能','仅在允许控制后，才能向本机发送键盘和鼠标操作。','待开启')]:
 row(252,y,t,s);pill(1190,y+29,b,GREEN if b!='待开启' else '#A46B19')
button(276,581,'打开系统设置',220,'primary',2);button(514,581,'重新检测',150,'secondary',2);button(1144,581,'设置协助许可',220,'secondary',3)
box(252,670,1136,170,'#FFF4E2');txt(278,693,'另一种状态：当前安装包不支持被控',22,'#925C17');txt(278,738,'显示具体原因与适用平台。只提供受支持的版本指引，不反复引导开启系统权限。',16,'#925C17');txt(278,776,'屏幕权限可用但辅助功能缺失时：可开启仅观看；控制入口禁用并显示原因。',16,'#925C17');save(2,'权限准备与能力降级')
base(3,'允许谁协助这台电脑','协助许可决定谁可以发起请求，不等于对方已经获得控制权。','长期许可与记住允许独立；撤销结果未确认时提示失败，并提供立即停止入口。')
box(252,214,680,642);txt(284,244,'本机协助',24);txt(284,299,'设备',15,MUT);box(284,329,616,51,BG,9);txt(301,345,'设计工作站  /  macOS',17)
txt(284,410,'允许协助的账号',15,MUT);box(284,440,616,51,BG,9);txt(301,455,'陈同学  ·  已添加联系人',17)
txt(284,522,'可发起请求的有效期',15,MUT)
button(284,555,'15 分钟',125,'secondary',3);button(425,555,'1 小时',110,'secondary',3);button(551,555,'长期有效，直到撤销',325,'primary',3)
txt(284,625,'首次请求仍需本机确认。是否自动批准取决于授权窗口的选择。',14,MUT)
button(284,686,'保存许可并上线',250,'primary',1);button(552,686,'停止协助并离线',260,'danger',9)
box(956,214,432,642);txt(984,244,'当前许可',24);txt(984,305,'陈同学',21);pill(984,351,'长期有效');txt(984,410,'记住的允许：无',17);button(984,459,'撤销该许可',350,'danger',3)
line(984,543,1358,543);txt(984,573,'恢复每次确认',20);txt(984,613,'清除本机保存的允许选项。',15,MUT);txt(984,643,'不会结束正在进行的会话。',15,MUT);button(984,704,'清除记住的允许',350,'secondary',3);save(3,'协助许可与长期访问')
base(4,'等待对方确认','你正在请求控制「设计工作站」。','取消后撤回请求；拒绝、超时和离线分别说明原因。倒计时由请求实际期限驱动。')
box(434,234,780,594);pill(743,274,'请求已送达');txt(576,351,'等待陈同学在本机允许',30);txt(592,415,'请求范围：观看屏幕 + 键盘鼠标',19,MUT)
for y,t in [(487,'已找到在线设备'),(535,'已发出控制请求'),(583,'对方确认后开始连接')]:txt(580,y,'•  '+t,18,GREEN if y<583 else MUT)
button(594,689,'取消请求',220,'secondary',1);button(837,689,'演示本机确认',244,'primary',5);save(4,'等待授权')
base(5,'本机授权确认','被控端 · 请求弹窗示意（实现使用系统原生确认窗口）','“不再提示”默认不勾选；仅保存实际允许范围。拒绝、关闭或过期不保存允许。')
box(433,216,790,622);pill(467,248,'来自已许可联系人');txt(467,301,'陈同学希望控制这台电脑',30);txt(467,361,'设备：设计工作站     请求范围：屏幕与键鼠',18,MUT)
box(467,412,722,107,BG);txt(490,434,'允许控制后，对方可以操作你当前屏幕上的应用。',18);txt(490,473,'你可以随时通过悬浮条结束协助。',17,MUT)
box(469,562,22,22,WHITE,4,LINE);txt(506,559,'不再提示：记住对此账号的本次允许范围',17);txt(506,602,'允许查看仅记住查看；后续扩大到控制仍需重新确认。',14,MUT)
button(467,700,'拒绝',160,'danger',9);button(647,700,'仅允许查看',230,'secondary',6);button(897,700,'允许控制',292,'primary',7);save(5,'本机查看与控制授权')
for n,title,sub,control in [(6,'正在观看设计工作站','仅观看，尚未授予键鼠控制权限。',False),(7,'正在控制设计工作站','键鼠控制已获本机允许；你可随时暂停操作或结束协助。',True)]:
 base(n,title,sub,'顶部持续显示权限范围；未授权的能力不发送输入。结束立即停止画面并释放键鼠。')
 box(252,211,1136,48,WHITE,10);pill(268,221,'可控制' if control else '仅观看');txt(420,225,'主显示器     适应窗口',14,MUT)
 button(818,213,'暂停操作' if control else '请求控制',170,'secondary',8 if control else 4);button(1002,213,'连接信息',165,'secondary',8);button(1182,213,'结束协助',190,'danger',9)
 desktop();box(252,781,1136,81,WHITE);txt(277,801,'会话状态',17);txt(405,801,'已连接  ·  画面正常  ·  当前仅共享主显示器',16,GREEN);txt(277,831,'文件、剪贴板和多屏入口将在能力完成后开放。',14,MUT);save(n,'键鼠控制会话' if control else '仅观看会话')
base(8,'操作已暂停，画面仍在共享','暂停输入与连接中断是不同状态，需要给出不同恢复方式。','返回前台不自动发送输入；按暂停原因重新校验或申请允许。媒体停滞则结束并明确告知。')
box(252,211,1136,56,'#FFF1DB');txt(278,217,'键鼠操作已暂停',18,'#A46B19');txt(278,245,'示例原因：离开控制窗口或输入授权过期。当前请勿继续操作远程桌面。',12,'#A46B19')
desktop();box(560,380,536,220,WHITE,18);txt(592,410,'准备好后恢复操作',25);txt(592,460,'恢复前将核对画面与控制权限；',17,MUT);txt(592,493,'需要重新授权时，会再次通知被控端。',17,MUT);button(592,539,'重新请求控制',230,'primary',4);button(840,539,'保持观看',220,'secondary',6)
button(252,803,'结束协助',190,'danger',9);txt(470,814,'连接中断 / 画面停滞：转入结束状态，提供明确原因与重新连接。',16,MUT);save(8,'暂停与异常恢复')
base(9,'本次协助已结束','远程画面和键鼠控制已停止。','结束页显示实际原因；重连生成新请求。保留许可不代表继续共享，不自动重连或免确认。')
box(434,234,780,594);pill(742,276,'已断开');txt(630,345,'控制权已归还本机',30);txt(580,415,'结束原因：你主动结束了本次协助',19,MUT);txt(580,472,'设备：设计工作站',18);txt(580,517,'本次范围：查看屏幕与键鼠控制',18);txt(580,566,'长期协助许可仍保留，可在设置中撤销。',16,MUT)
button(532,696,'返回设备列表',255,'secondary',1);button(812,696,'重新请求协助',280,'primary',4);save(9,'会话结束')
base(10,'我的设备','登记设备身份，并查看这台设备实际具备的协助能力。','登记不等于上线；移除设备需二次确认并说明身份撤销影响。离线/占用状态不能发起连接。',nav='我的设备')
button(1160,116,'登记本机',220,'primary',2)
for y,a,b,c in [(226,'设计工作站','macOS  ·  此设备  ·  屏幕及键鼠能力就绪','在线'),(364,'办公室电脑','Windows  ·  已登记  ·  被控能力尚未开放','离线'),(502,'家用电脑','macOS  ·  需要检查引擎与系统权限','待检查')]:
 box(252,y,1136,115);txt(280,y+23,a,23);txt(280,y+69,b,16,MUT);pill(955,y+26,c);button(1130,y+39,'查看设置',230,'secondary',2)
box(252,665,1136,166,'#E4F4EE');txt(280,689,'设备身份与连接权限分别管理',23,GREEN);txt(280,740,'设备登记用于识别电脑；协助许可决定谁可发起请求；本机允许决定本次查看或控制范围。',17,GREEN);save(10,'设备管理')
base(11,'后续能力 · 产品规划','规划界面，尚未实现的功能不在生产界面伪装为可用。','规划入口仅用于评审。文件、剪贴板、屏幕选择均需独立权限与实际能力检测。',nav='文件传输')
for i,(title,ls) in enumerate([('文件与协作',['文件传输：选择 → 对方接受 → 进度 → 完成','剪贴板：独立开关，文本优先','会话聊天与语音、白板标注']),('画面与性能',['显示器选择 / 适应窗口 / 原始比例','清晰度与帧率预设、带宽策略','连接信息、丢帧与重连说明']),('设备与运维',['分组、设备别名、连接记录','无人值守访问独立设置与撤销','远程锁屏 / 重启需二次确认']),('进阶能力',['多人协作与控制权管理','外设映射、虚拟屏、远程打印','隐私屏、录屏、审计与团队权限'])]):
 x=252+(i%2)*580;y=220+(i//2)*301;box(x,y,554,273);pill(x+23,y+21,'规划中','#A46B19');txt(x+23,y+68,title,25)
 for j,s in enumerate(ls):txt(x+23,y+121+j*42,s,16,MUT)
save(11,'后续能力规划')
(ROOT/'pages.json').write_text(json.dumps(pages,ensure_ascii=False,indent=2))
parts=['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>ToDesk 远控交互原型</title><style>body{margin:0;background:#152b3b;font-family:sans-serif}nav{padding:12px;color:white;position:sticky;top:0;background:#152b3b;z-index:2}nav a{color:#88e3c7;margin-right:16px;font-size:13px}.page{position:relative;max-width:1440px;margin:auto}.page img{width:100%;display:block}.hot{position:absolute;cursor:pointer}.hot:hover{outline:2px solid #00ba91;background:#00ba9115}</style><nav>交互设计稿 · 点击控件跳转　']
for i,p in enumerate(pages):parts.append(f'<a href="#{i}">{i:02d} {html.escape(p["title"])}</a>')
parts.append('</nav><main id="root"></main><script>const pages='+json.dumps(pages,ensure_ascii=False)+';function render(){const n=Number(location.hash.slice(1))||0;const p=pages[n]||pages[0];document.getElementById("root").innerHTML=`<div class="page"><img src="png/${p.file}" alt="${p.title}">${p.links.map(h=>`<a class="hot" aria-label="${h.label}" href="#${h.target}" style="left:${h.x/14.4}%;top:${h.y/10}%;width:${h.w/14.4}%;height:${h.h/10}%"></a>`).join("")}</div>`;}onhashchange=render;render();</script></html>')
(ROOT/'index.html').write_text(''.join(parts))
print('Generated',len(pages),'boards')
