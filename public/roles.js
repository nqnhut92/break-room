// Company roles a player can pick on the join screen. The ids must match ROLE_IDS in lib/world.js (the server
// only accepts those; a test compares both lists). Everything else here is for show.
//   hit:  extra words that fly out when this role smashes something
//   joke: the line added to the "X smashed Y" notice
export const ROLES = [
  { id: 'nv', emoji: '😩', label: 'Nhân viên quèn', short: 'Nhân viên', hit: ['ỨC CHẾ!', 'LƯƠNG ƠI!', 'OT!'], joke: 'xả stress sau 3 tháng không tăng lương' },
  { id: 'kt', emoji: '🧮', label: 'Kế toán', short: 'Kế toán', hit: ['QUYẾT TOÁN!', 'LỆCH SỔ!', 'VAT!'], joke: 'ghi vào sổ là chi phí hợp lý' },
  { id: 'hr', emoji: '🗂️', label: 'Nhân sự', short: 'HR', hit: ['CẢNH CÁO!', 'KỶ LUẬT!', 'PHỎNG VẤN!'], joke: 'lập biên bản chính mình' },
  { id: 'it', emoji: '🔧', label: 'IT', short: 'IT', hit: ['REBOOT!', 'TICKET!', 'ĐÃ TẮT BẬT!'], joke: 'bảo hành thế nào cũng được' },
  { id: 'dev', emoji: '💻', label: 'Dev', short: 'Dev', hit: ['BUG!', 'HOTFIX!', 'MERGE!'], joke: 'chạy ngon trên máy tôi mà' },
  { id: 'sale', emoji: '💼', label: 'Sale', short: 'Sale', hit: ['CHỐT ĐƠN!', 'DEAL!', 'HOA HỒNG!'], joke: 'chốt luôn được chưa anh' },
  { id: 'mkt', emoji: '🎨', label: 'Marketing', short: 'Marketing', hit: ['VIRAL!', 'TRENDING!', 'BRIEF!'], joke: 'lên kế hoạch truyền thông vụ này' },
  { id: 'dsg', emoji: '🖌️', label: 'Designer', short: 'Designer', hit: ['SỬA LẦN 99!', 'FONT!', 'LÀM LẠI!'], joke: 'khách bảo logo to lên chút' },
  { id: 'ts', emoji: '🍼', label: 'Thực tập sinh', short: 'Thực tập', hit: ['EM XIN LỖI!', 'MUA CÀ PHÊ!', 'ỦA?'], joke: 'bị sai đi photo tài liệu' },
  { id: 'bv', emoji: '🛡️', label: 'Bảo vệ', short: 'Bảo vệ', hit: ['DỪNG LẠI!', 'THẺ ĐÂU?', 'TUẦN TRA!'], joke: 'đang tuần tra thì lỡ tay' },
  { id: 'tv', emoji: '🧹', label: 'Tạp vụ', short: 'Tạp vụ', hit: ['DỌN!', 'LAU!', 'RÁC!'], joke: 'tự đập tự dọn luôn' },
];
export const ROLE_BY_ID = Object.fromEntries(ROLES.map((r) => [r.id, r]));
