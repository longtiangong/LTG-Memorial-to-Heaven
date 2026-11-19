import hashlib
import json

import numpy as np
from opencc import OpenCC
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps
from rapidocr_onnxruntime import RapidOCR
import requests
import streamlit as st

# 頁面以手機直向操作為主，使用置中版面與大尺寸表單控制項。
st.set_page_config(
    page_title="光明燈上架確認系統",
    page_icon="🏮",
    layout="centered",
)

st.markdown(
    """
    <style>
    .stButton > button {
        min-height: 3.25rem;
        width: 100%;
        font-size: 1.2rem;
        border-radius: 0.75rem;
    }
    .stTextInput input, .stSelectbox, .stRadio {
        font-size: 1.1rem;
    }
    h1, h2, h3 { text-align: center; }
    .status-card {
        padding: 1rem;
        border-radius: 0.75rem;
        font-size: 1.25rem;
        font-weight: bold;
        text-align: center;
        margin-bottom: 1rem;
    }
    /* 縮小拍照框寬度，但不強制裁切上下影像 */
    [data-testid="stCameraInput"] {
        max-width: 380px;
        margin: 0 auto;
    }
    [data-testid="stCameraInput"] video,
    [data-testid="stCameraInput"] img {
        max-height: none;
        object-fit: contain;
        border-radius: 0.75rem;
    }
    </style>
    """,
    unsafe_allow_html=True,
)


# * 1191425 調整OCR功能並加信心度
@st.cache_resource(show_spinner="正在載入 OCR 與繁體中文轉換模型...")
def load_ocr_models():
    ocr_engine = RapidOCR()
    # 使用 s2t 進行簡繁字形轉換，較能保留專有名詞與燈號字形。
    converter = OpenCC("s2t")
    return ocr_engine, converter


# * 1191425 調整OCR功能並加信心度
def _preprocess_roi_for_ocr(roi_image: Image.Image) -> Image.Image:
    """強化 ROI 區域對比與筆畫清晰度，協助辨識手寫編號與文字。"""
    rgb_img = roi_image.convert("RGB")
    auto_img = ImageOps.autocontrast(rgb_img, cutoff=1)
    contrast_img = ImageEnhance.Contrast(auto_img).enhance(1.45)
    sharp_img = contrast_img.filter(ImageFilter.SHARPEN)
    return sharp_img


# * 1191425 調整OCR功能並加信心度
def run_ocr_with_confidence(roi_image: Image.Image, ocr_engine: RapidOCR, converter: OpenCC):
    """僅針對 ROI 區域進行 OCR 辨識並保留逐行信心度。"""
    processed_img = _preprocess_roi_for_ocr(roi_image)
    img_array = np.array(processed_img)
    result, _ = ocr_engine(img_array)

    lines = []
    details = []
    if result:
        for item in result:
            _, raw_text, score = item
            cleaned_raw = (raw_text or "").strip()
            if cleaned_raw:
                trad_text = converter.convert(cleaned_raw).strip()
                confidence = float(score)
                lines.append(trad_text)
                details.append(
                    {
                        "文字": trad_text,
                        "原始輸出": cleaned_raw,
                        "信心度": f"{confidence:.2%}",
                        "信心度數值": round(confidence, 4),
                        "來源": "ROI",
                    }
                )

    scanned_text = "\n".join(lines).strip()
    return scanned_text, details


# * 11191445 調整長方形大小
def get_vertical_rect_box(
    image_size: tuple[int, int],
    height_ratio: float = 0.94,
    aspect_w_to_h: float = 0.85,
    width_scale: float = 1.5,
    offset_x_ratio: float = 0.0,
    offset_y_ratio: float = -0.04,
) -> tuple[int, int, int, int]:
    """回傳直立長方形 (left, top, right, bottom)，寬度放大 width_scale 倍並保持高大於寬。"""
    w, h = image_size
    crop_h = max(2, min(h, int(h * height_ratio)))
    base_w = max(1, int(crop_h * aspect_w_to_h))
    crop_w = max(1, int(base_w * width_scale))

    # 維持直立長方形（寬小於高）且不超過圖片寬度 96%
    max_vertical_w = max(1, min(int(w * 0.96), crop_h - 1))
    if crop_w > max_vertical_w:
        crop_w = max_vertical_w

    center_x = int(w * (0.5 + offset_x_ratio))
    center_y = int(h * (0.5 + offset_y_ratio))

    left = center_x - crop_w // 2
    top = center_y - crop_h // 2

    # 邊界 clamp，避免超出圖片範圍
    if left < 0:
        left = 0
    if left + crop_w > w:
        left = max(0, w - crop_w)

    if top < 0:
        top = 0
    if top + crop_h > h:
        top = max(0, h - crop_h)

    right = min(w, left + crop_w)
    bottom = min(h, top + crop_h)
    return (left, top, right, bottom)


# * 11191445 調整長方形大小
def crop_center_rectangle(
    pil_image: Image.Image,
    height_ratio: float = 0.94,
    aspect_w_to_h: float = 0.85,
    width_scale: float = 1.5,
    offset_x_ratio: float = 0.0,
    offset_y_ratio: float = -0.04,
) -> Image.Image:
    box = get_vertical_rect_box(
        pil_image.size,
        height_ratio=height_ratio,
        aspect_w_to_h=aspect_w_to_h,
        width_scale=width_scale,
        offset_x_ratio=offset_x_ratio,
        offset_y_ratio=offset_y_ratio,
    )
    return pil_image.crop(box)


def build_roi_guide_image(
    base_image: Image.Image | None,
    height_ratio: float,
    aspect_w_to_h: float,
    width_scale: float,
    offset_x_ratio: float,
    offset_y_ratio: float,
) -> Image.Image:
    """建立含 ROI 框線的對齊參考圖，協助判斷要拍攝哪些區域。"""
    if base_image is None:
        canvas = Image.new("RGB", (640, 480), color="#2B2F36")
    else:
        canvas = base_image.copy()

    box = get_vertical_rect_box(
        canvas.size,
        height_ratio=height_ratio,
        aspect_w_to_h=aspect_w_to_h,
        width_scale=width_scale,
        offset_x_ratio=offset_x_ratio,
        offset_y_ratio=offset_y_ratio,
    )
    draw = ImageDraw.Draw(canvas)
    draw.rectangle(box, outline="#00E676", width=5)

    left, top, right, bottom = box
    label_y = max(8, top - 28)
    draw.text((left + 8, label_y), "ROI: 號碼 / 姓名 / 燈名", fill="#00E676")
    return canvas


# 使用瀏覽器語音合成回報上架及增修查詢結果。
def speak_audio(text):
    safe_text = json.dumps(text, ensure_ascii=False).replace("<", "\\u003c")
    st.components.v1.html(
        f"""
        <script>
        const utterance = new SpeechSynthesisUtterance({safe_text});
        utterance.lang = "zh-TW";
        utterance.rate = 1;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
        </script>
        """,
        height=0,
    )


# GAS 共用既有 Web App 與 API 金鑰，回傳明確錯誤供畫面顯示。
def call_gas_api(payload):
    try:
        response = requests.post(
            st.secrets["WEB_APP_URL"],
            json=payload,
            timeout=60,
        )
        response.raise_for_status()
        result = response.json()
    except requests.RequestException as error:
        return {"status": "error", "message": f"連線 GAS 失敗：{error}"}
    except ValueError:
        return {"status": "error", "message": "GAS 回傳內容不是有效的 JSON。"}

    if not isinstance(result, dict):
        return {"status": "error", "message": "GAS 回傳格式不正確。"}
    return result


# 保留太歲分類選項；太歲工作表 ID 尚未提供，目前只開放光明燈。
st.sidebar.title("🏮 燈品分類管理")
category = st.sidebar.radio("選擇燈種類別", ["光明燈", "太歲"])

if category == "太歲":
    st.title("🏮 太歲上架確認")
    st.info("目前先完成光明燈；太歲工作表建立後再開放此功能。")
    st.stop()

required_secrets = (
    "SHEET_300_ID",
    "SHEET_500_ID",
    "WEB_APP_URL",
    "GAS_API_KEY",
)
missing_secrets = [key for key in required_secrets if not st.secrets.get(key)]
if missing_secrets:
    st.error(f"請在 Streamlit Secrets 設定：{', '.join(missing_secrets)}")
    st.stop()
if not st.secrets["WEB_APP_URL"].strip().endswith("/exec"):
    st.error("WEB_APP_URL 必須是 Apps Script Web App 的 /exec 網址。")
    st.stop()

sheet_ids = {
    "300": st.secrets["SHEET_300_ID"],
    "500": st.secrets["SHEET_500_ID"],
}
api_key = st.secrets["GAS_API_KEY"]

# * 1191425 調整OCR功能並加信心度
ocr_engine, cc_converter = load_ocr_models()
if "rotate_deg" not in st.session_state:
    st.session_state["rotate_deg"] = 0

st.title("🏮 光明燈上架確認")
st.caption("拍攝燈殼後，系統會自動辨識 ROI 文字、比對 300 元及 500 元工作表並記錄上架結果。")

# * 11191445 調整長方形大小
rect_h_ratio = 0.94
rect_aspect_w_to_h = 0.85
rect_width_scale = 1.5
rect_offset_x_ratio = 0.0
rect_offset_y_ratio = -0.04

# * 1191425 調整OCR功能並加信心度
camera_image = st.camera_input("拍攝燈殼上的號碼、姓名及燈名")

if camera_image is None:
    st.session_state["scan_image_key"] = None
    st.session_state["scan_result"] = {}
    st.session_state["scan_ocr_text"] = ""
    st.session_state["scan_ocr_details"] = []

    # 尚未拍照時提供 ROI 參考框，方便判斷要對準哪些區域
    guide_img = build_roi_guide_image(
        None,
        height_ratio=rect_h_ratio,
        aspect_w_to_h=rect_aspect_w_to_h,
        width_scale=rect_width_scale,
        offset_x_ratio=rect_offset_x_ratio,
        offset_y_ratio=rect_offset_y_ratio,
    )
    st.image(
        guide_img,
        caption="ROI 對齊參考框（請將燈殼上的號碼、姓名及燈名對準綠色 ROI 區）",
        use_container_width=True,
    )
else:
    try:
        raw_bytes = camera_image.getvalue()
        base_digest = hashlib.sha256(raw_bytes).hexdigest()

        col_rot1, col_rot2 = st.columns(2)
        with col_rot1:
            if st.button("↻ 順時針轉 90°"):
                st.session_state["rotate_deg"] = (st.session_state["rotate_deg"] + 90) % 360
        with col_rot2:
            if st.button("↺ 逆時針轉 90°"):
                st.session_state["rotate_deg"] = (st.session_state["rotate_deg"] - 90) % 360

        with st.expander("微調 ROI 掃描區域大小與位置"):
            rect_h_ratio = st.slider(
                "ROI 高比例", min_value=0.40, max_value=0.98, value=rect_h_ratio, step=0.02
            )
            rect_aspect_w_to_h = st.slider(
                "直立寬高比（小於 1 為直立）",
                min_value=0.35,
                max_value=0.95,
                value=rect_aspect_w_to_h,
                step=0.05,
            )
            rect_width_scale = st.slider(
                "寬度倍率（預設 1.5 倍）",
                min_value=1.0,
                max_value=2.0,
                value=rect_width_scale,
                step=0.1,
            )
            rect_offset_x_ratio = st.slider(
                "左右位移", min_value=-0.25, max_value=0.25, value=rect_offset_x_ratio, step=0.02
            )
            rect_offset_y_ratio = st.slider(
                "上下位移（負值往上）",
                min_value=-0.25,
                max_value=0.25,
                value=rect_offset_y_ratio,
                step=0.02,
            )

        rotate_deg = st.session_state["rotate_deg"]
        scan_key = (
            f"{base_digest}:{rotate_deg}:"
            f"{rect_h_ratio}:{rect_aspect_w_to_h}:{rect_width_scale}:"
            f"{rect_offset_x_ratio}:{rect_offset_y_ratio}"
        )
        is_new_image = st.session_state.get("scan_image_key") != scan_key

        # 縮圖降低 OCR 處理負擔，並依旋轉角度轉正。
        image = Image.open(camera_image).convert("RGB")
        image.thumbnail((1600, 1600))
        if rotate_deg != 0:
            image = image.rotate(-rotate_deg, expand=True)

        # 上方 ROI 對齊檢視圖
        roi_guide_preview = build_roi_guide_image(
            image,
            height_ratio=rect_h_ratio,
            aspect_w_to_h=rect_aspect_w_to_h,
            width_scale=rect_width_scale,
            offset_x_ratio=rect_offset_x_ratio,
            offset_y_ratio=rect_offset_y_ratio,
        )
        st.image(
            roi_guide_preview,
            caption="拍攝 ROI 區域標示（綠色框內為實際辨識範圍）",
            use_container_width=True,
        )

        # * 11191445 調整長方形大小
        # 僅裁切出 ROI 區域，下方顯示與實際送入 OCR 辨識完全一致的 ROI 畫面
        roi_box = get_vertical_rect_box(
            image.size,
            height_ratio=rect_h_ratio,
            aspect_w_to_h=rect_aspect_w_to_h,
            width_scale=rect_width_scale,
            offset_x_ratio=rect_offset_x_ratio,
            offset_y_ratio=rect_offset_y_ratio,
        )
        roi_image = image.crop(roi_box)
        st.image(
            roi_image,
            caption="OCR 辨識區域（僅判讀此 ROI 區域）",
            use_container_width=True,
        )

        if is_new_image:
            st.session_state["scan_image_key"] = scan_key
            st.session_state["scan_result"] = {}
            st.session_state["scan_ocr_text"] = ""
            st.session_state["scan_ocr_details"] = []

            # * 1191425 調整OCR功能並加信心度
            with st.spinner("正在進行 ROI 區域 OCR 文字辨識..."):
                scanned_text, ocr_details = run_ocr_with_confidence(
                    roi_image, ocr_engine, cc_converter
                )

            st.session_state["scan_ocr_text"] = scanned_text
            st.session_state["scan_ocr_details"] = ocr_details

            if scanned_text:
                with st.spinner("正在自動核對掃描文字與兩份工作表..."):
                    result = call_gas_api(
                        {
                            "action": "scan_verify",
                            "apiKey": api_key,
                            "sheetIds": sheet_ids,
                            "scannedText": scanned_text,
                            "ocrDetails": ocr_details,
                        }
                    )
                st.session_state["scan_result"] = result
                if result.get("status") == "success":
                    speak_audio(
                        f"上架成功，{result['sheetName']}，"
                        f"第{result['lampIndex']}組，號碼"
                        f"{result['number']}，燈名{result['lightType']}"
                    )
                elif result.get("status") == "fail":
                    errors = "、".join(result.get("errors", ["資料"]))
                    speak_audio(f"上架失敗，不符合項目為{errors}，請重新掃描")
                elif result.get("status") == "ambiguous":
                    speak_audio("找到多筆相同姓名，無法判定，請重新掃描")
                elif result.get("status") == "not_found":
                    speak_audio("掃描文字未找到相符姓名或資料，請重新掃描")
            else:
                st.session_state["scan_result"] = {
                    "status": "not_found",
                    "message": "沒有辨識到文字，請重新拍攝。",
                }
                speak_audio("未辨識到文字，請重新拍攝")

        scanned_text = st.session_state.get("scan_ocr_text", "")
        ocr_details = st.session_state.get("scan_ocr_details", [])

        if scanned_text:
            st.info(f"**OCR 掃描文字（繁體中文）：**\n\n{scanned_text}")
            # * 1191425 調整OCR功能並加信心度
            with st.expander("查看逐行 OCR 信心度"):
                st.table(
                    [
                        {
                            "文字": row["文字"],
                            "信心度": row["信心度"],
                            "來源": row.get("來源", "ROI"),
                        }
                        for row in ocr_details
                    ]
                )
        else:
            st.warning("未辨識到文字，可嘗試旋轉角度或調整拍攝角度與光線後重新拍攝。")

    except OSError as error:
        st.error(f"無法讀取拍攝的圖片：{error}")
    except Exception as error:
        st.error(f"OCR 辨識失敗：{error}")

if camera_image is not None and st.session_state.get("scan_image_key"):
    scan_result = st.session_state.get("scan_result", {})
    if scan_result.get("status") == "success":
        st.markdown(
            '<div class="status-card" style="background:#d9ead3;color:#274e13">'
            "🟢 上架成功</div>",
            unsafe_allow_html=True,
        )
        st.success(
            f"符合「{scan_result['sheetName']}」："
            f"第 {scan_result['lampIndex']} 組，號碼 "
            f"{scan_result['number']}，燈名「{scan_result['lightType']}」；"
            f"已在第 {scan_result['rowNumber']} 列記錄綠燈。"
        )
    elif scan_result.get("status") in ("fail", "not_found", "ambiguous"):
        errors = scan_result.get("errors", [])
        if errors:
            st.markdown(
                '<div class="status-card" style="background:#ffe599;color:#7f6000">'
                "🟡 上架失敗，請重新掃描</div>",
                unsafe_allow_html=True,
            )
            st.error(f"不符合項目：**{'、'.join(errors)}**。")
        else:
            st.warning(scan_result.get("message", "無法判定，請重新掃描。"))
        if scan_result.get("sheetName"):
            st.caption(
                f"已在「{scan_result['sheetName']}」第 "
                f"{scan_result['rowNumber']} 列標示不符合欄位。"
            )
    elif scan_result.get("status") == "error":
        st.error(scan_result.get("message", "無法查詢工作表，請檢查 GAS 設定。"))

st.divider()
# 比對成功時保存的資料快照；新增或異動欄位會以紅燈提示重新掃描。
if st.button("🔍 查詢增修資料"):
    payload = {
        "action": "check_updates",
        "apiKey": api_key,
        "sheetIds": sheet_ids,
    }
    with st.spinner("正在檢查兩份光明燈工作表..."):
        result = call_gas_api(payload)

    if result.get("status") != "success":
        st.error(result.get("message", "查詢增修資料失敗。"))
    elif result.get("has_updates"):
        speak_audio("未上架")
        st.markdown(
            '<div class="status-card" style="background:#f4cccc;color:#990000">'
            "🔴 發現新增或修改資料</div>",
            unsafe_allow_html=True,
        )
        for sheet_result in result.get("sheets", []):
            st.write(
                f"**{sheet_result['sheetName']}**："
                f"{sheet_result['changedRows']} 筆待重新核對"
            )
        st.warning("請逐筆拍攝並完成驗證；通過後該列燈號會更新為綠燈。")
    else:
        speak_audio("目前資料皆已上架")
        st.success("目前兩份工作表都沒有待確認的新增或修改資料。")