> [!NOTE]
> Gongming.py此系統包含：
> - 光明燈疏文A3輸出
>   - 300元光明燈
>   - 500元光明燈
> - 太歲疏文A3輸出
>   - 300元太歲燈
>   - 500元太歲燈


==光明燈疏文A3輸出==
> 分成兩部份
>   - 查詢增加全家人資料
>   - 新增信徒資料

# 一、查詢增加全家人資料：
輸入名字再輸入密碼不變，要增加先輸入手機即可帶出相同手機的所有人，若沒有手機則打入地址可帶出相同住址的所有人，若再沒資料請帶出警告，先至新增信徒資料去建立相關資料
所有人的資料包含
1.住址
2.信士/信女
3.姓名
4.生辰年月日
5.生時
關聯的信徒資料google sheet 拉到streamlit/ screats.toml去執行



my_light_app/
├── .streamlit/
│   └── secrets.toml
├── app.py
├── packages.txt
└── Code.gs (部署在 Google Apps Script 雲端)

## 光明燈上架確認設定

本機設定放在 `.streamlit/secrets.toml`；部署到 Streamlit Community Cloud
時，請在 App 的 **Settings → Secrets** 設定相同的項目。

```toml
# 沿用現有設定值，不要更換
SHEET_500_ID = "沿用目前設定"
SHEET_300_ID = "沿用目前設定"
WEB_APP_URL = "沿用目前的 Apps Script /exec 網址"
GAS_API_KEY = "沿用目前的 API 金鑰"

# 待取得太歲工作表 ID 後再設定
TAISUI_SHEET_500_ID = "待提供"
TAISUI_SHEET_300_ID = "待提供"
```

不要將真實 ID 或 API 金鑰貼入此 README 或提交到 Git。光明燈上架確認
目前使用 `SHEET_300_ID`、`SHEET_500_ID`、`WEB_APP_URL` 及 `GAS_API_KEY`；
太歲工作表尚未整合，取得 ID 後再設定及開放功能。