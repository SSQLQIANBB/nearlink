from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import json,html
R=Path(__file__).parent; S=2; W=1440; H=1080
B='#2563EB'; BG='#F1F5F9'; INK='#1E293B'; MUT='#64748B'; LINE='#E2E8F0'; WHITE='#FFFFFF'; LIGHT='#EFF6FF'; AMBER='#92400E'
F='/System/Library/Fonts/Hiragino Sans GB.ttc'; pages=[]; overflow=[]
def font(n):return ImageFont.truetype(F,int(n*S))
def t(x,y,s,n=16,c=INK):
 d.text((x*S,y*S),s,font=font(n),fill=c)
 if x*S+d.textlength(s,font=font(n))>W*S:overflow.append(s)
def r(x,y,w,h,c=WHITE,rad=10,border=None):d.rounded_rectangle((x*S,y*S,(x+w)*S,(y+h)*S),radius=rad*S,fill=c,outline=border,width=S)
def rule(x,y,x2,y2):d.line((x*S,y*S,x2*S,y2*S),fill=LINE,width=S)
def btn(x,y,s,w=130,to=None,kind='primary'):
 r(x,y,w,38,B if kind=='primary' else '#FEF2F2' if kind=='danger' else LIGHT,6)
 t(x+12,y+9,s,14,WHITE if kind=='primary' else '#B91C1C' if kind=='danger' else B)
 if to is not None:links.append(dict(x=x,y=y,w=w,h=38,target=to,label=s))
def tag(x,y,s,planned=False):r(x,y,len(s)*12+18,25,'#FEF3C7' if planned else LIGHT,5);t(x+9,y+5,s,11,AMBER if planned else B)
def start(n,title,sub,note):
 global im,d,links
 im=Image.new('RGB',(W*S,H*S),BG);d=ImageDraw.Draw(im);links=[]
 t(48,23,f'{n:02d}  {title}',28);t(48,66,sub,14,MUT);tag(1210,28,'sycsq.top 增量设计')
 r(0,966,1440,114,'#172C4B',0);t(40,982,'交互与落地说明',16,'#93C5FD');t(224,982,note,14,WHITE)
 t(224,1012,'保留现有路由、联系人/群组和聊天工具栏；黄色标识为规划。人物、设备、指标均为示例。',13,'#CBD5E1')
 t(224,1040,'源码基线 221993e · 内测版 0.5.0-beta.13 · 当前仅部分 macOS 被控链路实测，能力按安装包与验收开放。',12,'#CBD5E1')
def save(n,name):
 p=f'{n:02d}-{name}.png'; im.save(R/'png'/p);pages.append(dict(file=p,title=name,links=links.copy()))
def chat():
 # Existing /remote shell: 1152 px max width, 320 px contact sidebar.
 r(144,116,1152,810,WHITE,16);r(144,116,320,810,'#F8FAFC',16);r(144,116,320,132,B,16)
 r(162,133,40,40,'#DBEAFE',9);t(172,141,'林',20,B);t(215,135,'林同学',16,WHITE);t(215,163,'● 在线',12,'#DBEAFE')
 btn(162,195,'个人中心',282,2,'secondary');t(175,268,'联系人',16,B);t(326,268,'我的群组',16,MUT);rule(164,300,442,300)
 for i,(name,desc) in enumerate([('陈同学','一起完成这次远程协助'),('设计小组','新消息'),('测试同学','离线')]):
  y=325+i*84
  if i==0:r(155,y-9,297,72,LIGHT,10)
  r(168,y,40,40,'#DBEAFE',8);t(178,y+8,name[0],20,B);t(224,y,name,15);t(224,y+28,desc,11,MUT)
 t(168,881,'ToDesk  内测版',12,MUT)
 t(494,138,'陈同学',18);t(494,167,'一起完成这次远程协助',12,MUT);rule(464,190,1296,190)
 r(484,216,40,40,'#DBEAFE',8);t(494,225,'陈',18,B);r(536,216,364,51,'#F1F5F9',9);t(550,232,'需要帮我看一下电脑上的设置。',16)
 r(882,296,376,51,'#DBEAFE',9);t(898,312,'可以，从下方工具栏发起远程控制。',16)
 rule(464,724,1296,724)
 for i,(s,tar) in enumerate([('屏幕共享',9),('远程控制',1),('视频通话',9),('语音通话',9)]):btn(485+i*177,739,s,164,tar,'secondary')
 rule(464,790,1296,790);t(489,813,'请输入消息…',15,'#94A3B8');t(489,876,'图片    文件    语音',13,MUT);btn(1157,873,'发送',112,None)
def route(title,desc):
 r(272,116,896,810,WHITE,12);btn(296,139,'返回聊天',126,0,'secondary');t(296,207,title,26);t(296,248,desc,14,MUT)
def profile():
 t(272,133,'个人中心',28);t(272,178,'管理您的个人信息   ·   ToDesk 内测版',14,MUT);btn(1042,143,'返回',126,0,'secondary')
 r(272,222,896,704,WHITE,10);t(300,247,'基本信息       账户安全       通知声音',15,MUT);t(765,247,'远程设备',15,B);rule(296,286,1144,286)
def session(view=False):
 chat();r(190,220,1060,660,'#172033',12);t(214,241,'陈同学 · 办公 Mac',18,WHITE);t(478,245,'仅观看' if view else '可控制',14,'#93C5FD');btn(944,236,'缩小',114,0,'secondary');btn(1070,236,'结束协助',154,6,'danger')
 r(210,291,1020,447,'#DCE8F7',6);r(240,320,666,375,WHITE,8);r(240,320,666,36,'#EEF2F7',8);t(260,329,'项目资料 / 示例窗口',12,MUT);t(275,383,'协作记录',26)
 for i,a in enumerate(['确认当前画面显示正常','进入设置面板检查显示选项','完成协助后主动结束连接']):t(276,448+55*i,a,18,MUT)
 r(940,363,264,190,'#F8FAFC',8);t(960,385,'本机提示',19);t(960,429,'正在共享屏幕',16,B);t(960,471,'随时可以结束协助',14,MUT)
 for i,(a,to) in enumerate([('画面 / 画质',7),('文件',8),('协作',9),('外设',13),('更多',11)]):btn(213+i*160,759,a,146,to,'secondary')
 t(213,825,'仅观看，尚未授予键鼠控制权限' if view else '键鼠操作中  ·  Esc 暂停  ·  30 fps / 48 ms（示例）',14,WHITE)
 btn(944,813,'请求控制' if view else '暂停操作',274,3 if view else 6,'secondary')
def panel(title,items,foot='保存后仅对当前会话生效',action='应用',to=5):
 r(786,282,444,588,WHITE,10);t(808,302,title,22);rule(808,341,1208,341)
 for i,(a,b) in enumerate(items):
  y=358+i*58;t(808,y,a,15);t(808,y+26,b,12,MUT)
 t(808,750,foot,12,MUT);btn(808,784,action,180,to);btn(1001,784,'取消',203,5,'secondary')
start(0,'在现有聊天工具栏进入远控','沿用 /remote：320 px 联系人栏、蓝色用户卡、联系人/群组标签、消息区和底部编辑器。','选择联系人 → 远程控制 → 01 设备页。通话占用时按钮禁用并解释原因。')
chat();r(526,431,680,193,LIGHT,10);t(550,453,'远程协助卡片 · 新增消息状态',21,B);t(550,495,'陈同学的办公 Mac 已准备就绪',16);t(550,530,'请求查看或控制，均以本机允许范围为准。',14,MUT);btn(550,571,'选择远程设备',220,1)
save(0,'现有聊天页增量入口')
start(1,'保留远控设备页，补齐连接状态','沿用 /remote-control?userId=… 与“返回聊天”，保留环境检测、可协助设备、我的设备。','无许可/离线/占用/无引擎分别给出原因；请求后等待，可取消；失败回到设备列表。')
route('远程控制','协助陈同学 · 选择已允许你发起请求的电脑')
r(296,288,848,83,LIGHT,8);t(315,303,'Web 主控环境检测通过',18,B);t(315,336,'可连接具备能力的桌面客户端。本机被控设置仅在桌面端展示。',14,MUT)
t(296,396,'可协助的设备',21)
for y,name,desc in [(440,'办公 Mac','在线 · 可查看 / 可控制'),(556,'家用电脑','离线 · 上线后可请求协助')]:
 r(296,y,848,96,'#F8FAFC',8);t(316,y+16,name,19);t(316,y+52,desc,14,MUT)
 if y==440:btn(780,y+29,'请求查看',150,3,'secondary');btn(946,y+29,'请求控制',177,3)
 else:tag(946,y+30,'暂不可连接',True)
btn(296,683,'刷新列表',150,1,'secondary');btn(466,683,'我的远程设备',200,10,'secondary')
r(296,755,848,131,'#F8FAFC');t(316,775,'新增：等待本机确认',19);t(316,814,'请求控制 → 本机确认 → 建立连接 → 05 会话；拒绝/超时不自动重试。',14,MUT);btn(936,839,'取消请求',188,1,'secondary');save(1,'现有远控页与等待状态')
start(2,'个人中心 · 远程设备 · 本机协助','沿用现有个人中心标签结构，在 RemoteHostSettings 内整理权限和协助许可。','先检测安装包引擎，再查录屏/辅助功能；长期许可与记住允许分开管理。')
profile();t(300,308,'开启本机协助',23);tag(982,309,'桌面端专属')
for i,(a,b) in enumerate([('本机设备','办公 Mac  v'),('允许请求的联系人','陈同学  v'),('许可有效期','15 分钟   /   1 小时   /   长期直到撤销')]):
 y=356+75*i;t(300,y,a,14,MUT);r(490,y-7,646,47,'#F8FAFC',6,LINE);t(507,y+6,b,15)
btn(300,585,'允许请求协助',208,2);btn(528,585,'本机上线',162,1);btn(710,585,'恢复每次确认',208,2,'secondary')
rule(300,646,1140,646);t(300,666,'系统权限与被控能力',21);t(300,711,'屏幕录制：已开启      辅助功能：待开启      引擎：已检测',15)
btn(300,753,'打开系统设置',214,2,'secondary');btn(534,753,'重新检测',160,2,'secondary')
t(300,818,'许可：陈同学 · 长期有效     记住允许：无',15,MUT);btn(951,809,'撤销许可',180,2,'danger');t(300,871,'缺少引擎时显示版本不支持；Web 隐藏本机上线及系统权限操作。',13,MUT);save(2,'个人中心本机协助')
start(3,'本机确认与权限升级','保留当前原生确认机制；下图为信息布局示意，实际原生窗口遵守平台样式。','拒绝/超时不连接；记住允许默认不勾选；查看升级控制须覆盖新的授权范围。')
chat();r(430,321,658,430,WHITE,14,LINE);t(462,350,'陈同学希望控制这台电脑',26);t(462,405,'设备：办公 Mac     范围：屏幕与键盘鼠标',16)
r(462,455,594,86,LIGHT,8);t(480,471,'允许控制后，对方可以操作当前桌面上的应用。',16);t(480,506,'本机悬浮条始终提供“结束协助”。',14,MUT)
t(462,575,'□ 不再提示：记住对此账号的允许范围',16);t(462,611,'可在个人中心恢复每次确认；该操作不会结束当前会话。',12,MUT)
btn(462,673,'拒绝',130,1,'danger');btn(607,673,'仅允许查看',210,4,'secondary');btn(832,673,'允许控制',224,5);save(3,'本机授权弹窗')
for n,view in [(4,True),(5,False)]:
 start(n,'会话浮层 · '+('仅观看' if view else '键鼠控制'),'沿用 GlobalRemoteControl：聊天页上的可缩小浮层，保留设备名、状态、结束、统计和输入控制。','会话工具栏新增分组面板；未实现按钮只在设计评审中展示，生产按能力隐藏。')
 session(view);save(n,'仅观看会话' if view else '键鼠控制会话')
start(6,'暂停、重连与结束清晰分离','沿用会话浮层，补齐离焦、输入许可过期、链路关闭、画面停滞及主动结束反馈。','切换窗口只暂停输入；链路或画面不可恢复才结束。重连创建新请求，不能静默取得控制权。')
session();r(432,383,590,296,WHITE,12);t(461,410,'键鼠操作已暂停',26);t(461,460,'画面仍在共享：你离开了控制窗口。',16);t(461,502,'返回后确认画面，再继续操作；许可过期则重新申请。',13,MUT);btn(461,555,'继续操作',240,5);btn(720,555,'保持观看',270,4,'secondary');t(461,622,'已断开时：显示原因 / 返回设备 / 重新请求；不自动重连。',12,MUT);save(6,'暂停断线结束状态')
start(7,'会话浮层 · 画面与画质面板','整合基础画面与网络画质功能；单独的连接诊断展示实测值，禁止用设计数值冒充能力。','屏幕/窗口切换需重验权限与坐标；带宽不足时优先降画质，暂停输入时保留结束入口。')
session();panel('画面与画质 · 规划', [('显示内容','主屏 v / 多屏 / 窗口 / 指定应用 / 虚拟屏'),('缩放与桌面','适应窗口 · 原始比例 · 隐藏壁纸'),('性能模式','流畅 / 均衡 / 清晰；真彩 HDR 依硬件开放'),('帧率与带宽','目标帧率 v · 垂直同步 · 带宽限额'),('线路与网络','自动 / SD-WAN / 全球节点；代理在设备设置'),('交互保护','延迟过高暂停输入 · 鼠标响应优化')]);save(7,'画面与网络画质')
start(8,'会话浮层 · 文件与剪贴板','新增会话文件面板，沿用聊天已有文件消息的视觉；远控文件协议与聊天附件分别标识。','发送 → 对方接受 → 进度 → 完成/失败重试；剪贴板独立授权，可设置只发送/只接收。')
session();panel('文件与剪贴板 · 规划',[('文件传输','选择文件 → 请求对方接收'),('任务进度','项目资料.zip  42%     暂停 / 取消'),('失败处理','网络中断：保留任务，明确重试范围'),('剪贴板','关闭 / 仅文本 / 双向；默认关闭'),('远程打印','选择打印机 → 预览 → 对方确认'),('批量分发','转到设备管理，选择目标并逐台报告')],action='选择文件',to=8);save(8,'文件剪贴板与打印')
start(9,'现有聊天与通话 · 增加协作工具','复用消息区、语音/视频通话、共享与白板基础组件；远控中的媒体并发需要独立验收。','邀请成员时说明共享范围；多人控制采用明确控制权交接，查看者不自动获得操作权限。')
session();panel('协作 · 部分复用 / 部分规划',[('文字与语音','回到聊天 / 发起语音；占用时提示先结束当前媒体'),('邀请协助','复制链接 / 协助码，显示有效期与撤销'),('白板标注','画笔 / 颜色 / 撤销 / 清除；不把标注当鼠标输入'),('成员与控制权','陈同学：控制中；林同学：观看 → 请求控制'),('摄像头与麦克风','独立授权、开启指示与关闭入口'),('会话录像','开始前通知双方；存储位置与停止常驻')]);save(9,'聊天通话与协作')
start(10,'个人中心 · 远程设备列表扩展','保留登记、撤销登记、设备别名；新增分组、通知与设备详情抽屉。','设备身份≠在线≠允许控制。撤销说明影响并确认；同账号也必须满足许可和授权范围。')
profile();t(300,309,'我的远程设备',23);btn(935,306,'登记当前设备',204,2);t(300,366,'全部设备    办公    家庭    + 新建分组（规划）',15,B)
for i,(a,b) in enumerate([('办公 Mac','在线 · 当前设备 · 查看/控制就绪'),('测试电脑','离线 · 能力待检测'),('备用电脑','已登记 · 当前安装包暂不具备被控引擎')]):
 y=414+i*115;r(300,y,840,98,'#F8FAFC');t(320,y+17,a,20);t(320,y+57,b,14,MUT);btn(978,y+29,'设备详情',142,11,'secondary')
btn(300,799,'屏幕墙（规划）',220,15,'secondary');btn(540,799,'批量分发（规划）',242,8,'secondary');t(300,867,'设备详情新增：别名 / 每设备设置 / 上下线提醒 / 硬件信息 / 诊断日志。',13,MUT);save(10,'现有个人中心设备管理')
start(11,'设备详情 · 运维操作','从个人中心设备行进入；普通远控操作与管理员运维权限分开。','重启/关机/锁屏显示目标和影响并确认；远端不可用时禁用，不把指令送达当执行成功。')
profile();t(300,309,'办公 Mac  /  设备详情',25)
for i,(a,b) in enumerate([('身份与设置','别名 · 分组 · 网络代理 · 每设备设置 · 上下线提醒'),('硬件与诊断','系统与硬件信息 · 连接日志 · 脱敏导出'),('电源与会话','防止休眠 · 锁屏 · 重启 · 关机 · 唤醒能力检测'),('应用与终端','启动应用 · 远程更新 · CMD / SSH（规划）'),('无人值守','独立开通、凭据验证、撤销与审计（规划）')]):
  y=370+i*85;r(300,y,840,72,'#F8FAFC');t(320,y+10,a,18);t(320,y+40,b,14,MUT)
btn(300,834,'访问与安全',235,12,'secondary');btn(555,834,'重启前确认（示意）',282,11,'danger');save(11,'设备运维详情')
start(12,'账户安全与远控访问策略','沿用个人中心“账户安全”，将远程访问策略与系统登录凭据清晰区分。','隐私黑屏/禁用本地输入等高影响能力需明确告知、确认与本机逃生方式，未验收不开放。')
profile();t(300,309,'远程访问与隐私 · 规划扩展',24)
items=[('身份验证','访问名单 · 连接权限 · 临时密码轮换 · 二次验证'),('系统访问','系统密码验证 / 解锁；不保存明文系统密码'),('本机隐私','隐私黑屏 · 客户端锁定 · 结束后锁屏'),('输入保护','禁用本地键鼠 / 锁定光标；保留本机中止方式'),('透明与记录','同账号控制状态提示 · 会话录像 · AI 操作审计'),('现有安全基础','加密连接、许可撤销、记住允许范围与恢复每次确认')]
for i,(a,b) in enumerate(items):
 y=365+i*76;t(300,y,a,18);t(300,y+32,b,14,MUT);rule(300,y+63,1140,y+63)
btn(300,850,'保存策略（示意）',235,12);btn(555,850,'恢复每次确认',230,2,'secondary');save(12,'账户安全远控隐私')
start(13,'会话工具栏 · 外设映射','8 项外设能力集中在会话面板，依据操作系统、设备驱动、会话权限展示可用项。','检测 → 选择设备 → 请求授权 → 启用；显示占用/不兼容，结束后释放设备映射。')
session();panel('外设映射 · 全部规划',[('输入设备','游戏鼠标 · 3D 鼠标 · 游戏手柄'),('绘图与触控','数位板 / 压感笔 · 手机虚拟游戏键盘'),('音视频设备','摄像头 · 麦克风；独立授权与使用指示'),('快捷键','自定义快捷键 · 键盘布局适配'),('安全外设','加密狗 / U 盾；逐次明确授权'),('当前状态','未连接外设；不支持的平台解释原因')],action='检测设备',to=13);save(13,'外设映射面板')
start(14,'移动端、安卓与投屏的延伸','保留现有移动端联系人抽屉与聊天，不把移动端、安卓被控或电视能力标为已实现。','小屏优先显示结束、权限范围和输入模式；旋转/缩放重新映射坐标，系统手势保留。')
for x,title in [(190,'移动端聊天'),(565,'移动主控 · 规划'),(940,'投屏与安卓 · 规划')]:
 r(x,155,312,723,WHITE,25,LINE);r(x+12,168,288,64,LIGHT,12);t(x+28,187,title,18,B)
t(215,273,'≡  联系人 / 我的群组',17);r(215,329,259,82,BG);t(230,347,'陈同学：需要远程协助',15);btn(215,701,'远程控制',258,1);t(215,767,'原工具栏自动换行',14,MUT)
r(590,260,262,235,'#DCE8F7');t(613,353,'远程画面',24);t(590,539,'触控 / 虚拟鼠标',16);t(590,586,'输入文字 / 虚拟键盘',16);btn(590,650,'暂停输入',261,6,'secondary');btn(590,710,'结束协助',261,6,'danger')
t(965,271,'电视投屏',21);t(965,314,'选择接收端 → 配对确认',14,MUT);t(965,395,'安卓设备控制',21);t(965,438,'独立平台授权及能力检测',14,MUT);t(965,519,'扩展屏 / 镜像屏',21);t(965,562,'选择模式并确认显示范围',14,MUT);btn(965,709,'配对设备（示意）',262,14,'secondary');save(14,'移动端安卓电视投屏')
start(15,'会话切换与多设备屏幕墙','沿用设备列表和会话浮层；多标签、多会话、屏幕墙作为后续扩展，避免抢占当前输入。','切换先释放键鼠，再恢复目标会话；屏幕墙默认观看，批量操作逐台确认权限并报告结果。')
profile();t(300,310,'远程会话 · 规划',24);t(300,360,'办公 Mac（控制）    测试电脑（观看）    + 新会话',15,B)
for i,a in enumerate(['办公 Mac','测试电脑','家庭电脑','备用电脑']):
 x=300+(i%2)*433;y=414+(i//2)*190;r(x,y,407,164,'#DCE8F7');t(x+20,y+22,a,20);tag(x+20,y+68,'仅观看');btn(x+218,y+110,'打开会话',170,4,'secondary')
btn(300,835,'批量分发文件',235,8,'secondary');t(559,847,'多人协作与多光标进入会话“协作”面板。',14,MUT);save(15,'多会话与屏幕墙')
start(16,'现有页面上的交互路径','主路径保持：聊天 → 远控设备 → 本机确认 → 会话；设置统一回到个人中心。','实线主流程对应当前源码；黄色扩展按能力分期。失败、拒绝、撤销、结束均有返回路径。')
for i,(a,b,to) in enumerate([('00 聊天工具栏','选择联系人 / 点击远控',0),('01 设备与请求','在线 / 许可 / 能力校验',1),('03 本机允许','拒绝 / 查看 / 控制',3),('04–05 会话','暂停 / 结束 / 缩小',5)]):
 x=80+i*340;r(x,166,300,187,WHITE);t(x+20,191,a,22);t(x+20,237,b,15,MUT);btn(x+20,290,'查看界面',250,to)
for i,(a,b,to) in enumerate([('权限与许可','个人中心 → 远程设备 → 本机协助',2),('设备与运维','分组 / 详情 / 批量 / 无人值守',10),('会话扩展','画质 / 文件 / 协作 / 外设',7),('安全与审计','账户安全 / 策略 / 隐私 / 录像',12),('异常分支','离焦暂停；拒绝回退；断开后显式重连',6),('平台边界','Web 主控；桌面被控按实际能力；移动规划',14)]):
 x=80+(i%2)*680;y=408+(i//2)*166;r(x,y,640,143,WHITE);t(x+20,y+18,a,23);t(x+20,y+58,b,15,MUT);btn(x+451,y+93,'进入',163,to,'secondary')
save(16,'现有路由交互总览')
# Exact six-category conversation list. Defaults to planning; partial claims are explicit.
groups=[('基础远程控制', ['跨平台连接','浏览器发起连接','电视投屏','多显示器查看与切换','分辨率适配与缩放','隐藏桌面壁纸','手机触控与虚拟鼠标','安卓设备控制','多标签会话','仅观看','远程摄像头','多会话切换','消息通知','设备别名','同账号免密连接','防止休眠','网络代理'],[1,1,14,7,7,7,14,14,15,4,9,15,0,10,12,11,11]),('网络与画质',['SD-WAN加速','全球节点加速','低延迟传输','鼠标响应优化','高清与真彩/HDR','高帧率与垂直同步','性能模式切换','带宽限额','高延迟时暂停输入'],[7]*9),('远程协作',['跨平台文件传输','双向剪贴板','文字与语音交流','电脑向手机输入文字','扩展屏与镜像屏','虚拟显示器','窗口共享','白板标注','远程打印','多人同时控制','多光标协作','链接或协助码邀请','指定应用远控'],[8,8,9,14,14,7,7,9,8,9,9,9,7]),('外设映射',['游戏鼠标','手机虚拟游戏键盘','3D鼠标','游戏手柄','数位板与压感笔','摄像头与麦克风','自定义快捷键及键盘适配','加密狗与U盾'],[13]*8),('设备与运维',['无人值守连接','远程开关机/重启/锁屏','系统快捷操作','设备列表与分组','按设备保存设置','启动应用与远程更新','上下线提醒','硬件信息','诊断日志','多设备屏幕墙','批量分发文件','CMD/SSH终端'],[11,11,11,10,11,11,10,11,11,15,8,11]),('安全与隐私',['传输加密','访问黑白名单','连接权限策略','系统密码验证与解锁','临时密码轮换','二次验证','隐私黑屏','客户端锁定','结束远控后锁屏','禁用本地键鼠与锁定光标','AI操作审计','同账号控制状态提示','会话录像'],[12]*13)]
partial={'跨平台连接':'部分：Web→macOS；其他平台待验收','浏览器发起连接':'已有主控链路；按实际能力开放','分辨率适配与缩放':'部分：现有画面适配；选择项待补','仅观看':'已有：明确区分查看与控制','消息通知':'部分：聊天已有；远控状态需补','设备别名':'部分：登记时命名；编辑待补','同账号免密连接':'部分：许可与记住允许；非无条件免密','低延迟传输':'部分：WebRTC/TURN；性能待验收','鼠标响应优化':'部分：已有输入链路；优化待验收','高延迟时暂停输入':'部分：已有安全暂停；阈值策略待补','文字与语音交流':'部分：聊天/通话已有；并发需验收','窗口共享':'部分：屏幕共享已有；远控选择待补','白板标注':'部分：共享组件已有；远控整合待补','摄像头与麦克风':'部分：通话已有；外设映射未实现','设备列表与分组':'部分：设备列表已有；分组待补','诊断日志':'部分：工程日志已有；用户界面待补','传输加密':'已有协议基础；安全整体仍需验收','连接权限策略':'部分：许可/范围/撤销已有','同账号控制状态提示':'部分：会话状态已有；跨端提示待补'}
refs={0:'views/remoteShare/index.vue',1:'views/remoteControl/index.vue',2:'components/RemoteHostSettings.vue',4:'components/GlobalRemoteControl.vue',7:'components/GlobalRemoteControl.vue',8:'components/ChatMediaComposer.vue',9:'components/ScreenAnnotation.vue',10:'components/RemoteDeviceSettings.vue',11:'components/RemoteDeviceSettings.vue',12:'components/RemoteHostSettings.vue',13:'components/GlobalPrivateCall.vue',14:'views/remoteShare/index.vue',15:'components/GlobalRemoteControl.vue'}
features=[]; count=0
for gi,(group,names,targets) in enumerate(groups):
 n=17+gi;start(n,f'功能清单映射 · {group}',f'会话表格原项逐一对应，共 {len(names)} 项。状态指本地实现范围，不表示线上版本已经发布该能力。','点击本地原型中每行可进入对应设计页；规划功能仅用于评审，不作为产品已实现承诺。')
 r(64,118,1312,817,WHITE,12);t(86,140,'编号 / 功能',17);t(496,140,'当前状态',17);t(1090,140,'UI 落点',17);rule(85,173,1354,173)
 gap=42 if len(names)>15 else 52
 for j,(name,target) in enumerate(zip(names,targets)):
  count+=1;y=185+j*gap;status=partial.get(name,'规划：未验证当前项目具备该能力')
  t(86,y,f'{count:02d}   {name}',15);t(496,y,status,13,B if name in partial else AMBER);t(1090,y,f'{target:02d}  '+pages[target]['title'][:13],13,MUT);rule(85,y+gap-7,1354,y+gap-7)
  links.append(dict(x=80,y=y-3,w=1270,h=gap-4,target=target,label=name))
  features.append(dict(id=count,category=group,name=name,status=status,page=target,source='client-vue/src/'+refs[target]))
 save(n,group+'功能映射')
assert count==72
(R/'pages.json').write_text(json.dumps(pages,ensure_ascii=False,indent=2))
(R/'features.json').write_text(json.dumps(features,ensure_ascii=False,indent=2))
md=['# sycsq.top / 本地 ToDesk 增量 UI 设计 v2','', '设计基线：本地 master `221993e`，产品版本 `0.5.0-beta.13`。不改产品版本、不修改生产功能。','', '本稿替代旧的独立远控工作台方向。实际网站重新加载遇到网络错误；页面结构和样式依本地源码核对。保留 `/remote` 联系人/群组、320px 侧栏、1152px 网页卡片、蓝白配色和底部四项工具栏；桌面沿用全窗口布局。', '', '## 使用', '', '打开 index.html 查看可点击原型；图片内按钮和功能表行可跳转。蓝湖上传为静态 UI/交互图，不等于已制作蓝湖原生热点原型。示例人名、设备、数据均为虚构。','', '## 代码映射', '', '- 聊天：client-vue/src/views/remoteShare/index.vue 及 components/ToolBar.vue','- 个人中心：client-vue/src/views/profile.vue，RemoteDeviceSettings.vue，RemoteHostSettings.vue','- 远控：views/remoteControl/index.vue，components/GlobalRemoteControl.vue','- 桌面布局：client-vue/src/style/desktop.css；移动沿用现有联系人抽屉。','', '## 交互约束','','- 入口按环境和实测能力开放；通用发布包不因设计图显示而获得原生被控引擎。','- 本机登记、协助许可、会话允许是三件事。长期许可不等于无条件控制；记住允许只覆盖已明确同意范围。','- 仅观看不显示“操作已暂停”；离焦或输入授权问题只暂停输入，真正断开单独显示原因。','- 每次跨功能权限升级需核对真实范围；文件、剪贴板、外设、录像分别授权。','- 多屏/手机/安卓/运维/隐私等规划必须经过平台实现及验收后开放。','- 每个异步面板均需空态、加载、成功、拒绝、失败重试；离线和能力缺失说明原因。','- 高影响操作显示目标、范围、后果并确认，权限撤销失败不可假报成功。','', '## 72 项覆盖表','','|编号|类别|功能|当前状态|设计页|源码基点（不表示功能已实现）|','|---|---|---|---|---|---|']
for f in features:md.append(f"|{f['id']:02d}|{f['category']}|{f['name']}|{f['status']}|{f['page']:02d} {pages[f['page']]['title']}|{f['source']}|")
(R/'README.md').write_text('\n'.join(md)+'\n')
htmltext='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>sycsq.top 增量交互设计 v2</title><style>*{box-sizing:border-box}body{margin:0;font:14px system-ui;background:#e2e8f0;color:#1e293b}header{position:sticky;top:0;z-index:3;padding:12px 20px;background:white;border-bottom:1px solid #cbd5e1;display:flex;gap:16px;align-items:center}select,button{padding:8px;border:1px solid #cbd5e1;border-radius:6px;background:white}main{max-width:1440px;margin:auto;position:relative}img{width:100%;display:block}.hot{position:absolute;background:transparent;border:0;border-radius:6px;cursor:pointer}.hot:hover,.hot:focus-visible{outline:3px solid #2563eb;background:#2563eb22}a{color:#2563eb}</style><header><strong>sycsq.top 增量 UI v2</strong><select id="nav"></select><button onclick="history.back()">返回上一步</button><a href="README.md">72 项映射与边界</a><span>设计演示，不连接真实设备</span></header><main id="stage"></main><script>const pages=DATA;const nav=document.querySelector('#nav'),stage=document.querySelector('#stage');pages.forEach((p,i)=>{let o=document.createElement('option');o.value=i;o.textContent=String(i).padStart(2,'0')+' '+p.title;nav.append(o)});function show(){let n=Number(location.hash.slice(1))||0;if(!pages[n])n=0;nav.value=n;stage.replaceChildren();let im=new Image;im.src='png/'+pages[n].file;im.alt=pages[n].title;stage.append(im);pages[n].links.forEach(l=>{let b=document.createElement('button');b.className='hot';b.title=l.label;b.setAttribute('aria-label',l.label);Object.assign(b.style,{left:l.x/1440*100+'%',top:l.y/1080*100+'%',width:l.w/1440*100+'%',height:l.h/1080*100+'%'});b.onclick=()=>location.hash=l.target;stage.append(b)})}nav.onchange=()=>location.hash=nav.value;addEventListener('hashchange',show);show();</script></html>'''
(R/'index.html').write_text(htmltext.replace('DATA',json.dumps(pages,ensure_ascii=False)))
assert all(0<=l['target']<len(pages) for p in pages for l in p['links'])
print(json.dumps({'pages':len(pages),'features':count,'hotspots':sum(len(p['links']) for p in pages),'overflow':overflow},ensure_ascii=False))
