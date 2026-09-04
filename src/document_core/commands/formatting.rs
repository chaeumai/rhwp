//! 글자모양/문단모양 조회·적용 관련 native 메서드

use super::super::helpers::{
    border_line_type_to_u8_val, build_tab_def_from_json, color_ref_to_css, json_has_border_keys,
    json_escape, json_has_tab_keys, parse_char_shape_mods, parse_json_i16_array,
    parse_para_shape_mods,
};
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::event::DocumentEvent;
use crate::model::paragraph::Paragraph;
use crate::renderer::composer::reflow_line_segs;
use crate::renderer::page_layout::PageLayoutInfo;
use crate::renderer::style_resolver::{resolve_styles, ResolvedStyleSet};

fn char_shape_mods_affect_text_flow(mods: &crate::model::style::CharShapeMods) -> bool {
    mods.base_size.is_some()
        || mods.font_ids.is_some()
        || mods.ratios.is_some()
        || mods.spacings.is_some()
        || mods.relative_sizes.is_some()
        || mods.char_offsets.is_some()
}

fn body_available_width_for_para_shape(
    core: &DocumentCore,
    sec_idx: usize,
    para_shape_id: u16,
    styles: &ResolvedStyleSet,
) -> f64 {
    let Some(section) = core.document.sections.get(sec_idx) else {
        return 1.0;
    };
    let page_def = &section.section_def.page_def;
    let column_def = DocumentCore::find_initial_column_def(&section.paragraphs);
    let layout = PageLayoutInfo::from_page_def(page_def, &column_def, core.dpi);
    let col_width = layout
        .column_areas
        .first()
        .map(|a| a.width)
        .unwrap_or(layout.body_area.width);
    let para_style = styles.para_styles.get(para_shape_id as usize);
    let margin_left = para_style.map(|s| s.margin_left).unwrap_or(0.0);
    let margin_right = para_style.map(|s| s.margin_right).unwrap_or(0.0);
    (col_width - margin_left - margin_right).max(1.0)
}

impl DocumentCore {
    pub fn get_char_properties_at_native(
        &self,
        sec_idx: usize,
        para_idx: usize,
        char_offset: usize,
    ) -> Result<String, HwpError> {
        let section = self
            .document
            .sections
            .get(sec_idx)
            .ok_or_else(|| HwpError::RenderError(format!("구역 {} 범위 초과", sec_idx)))?;
        let para = section
            .paragraphs
            .get(para_idx)
            .ok_or_else(|| HwpError::RenderError(format!("문단 {} 범위 초과", para_idx)))?;
        Ok(self.build_char_properties_json(para, char_offset))
    }

    /// 셀 내부 문단의 글자 속성 조회 (네이티브)
    pub fn get_cell_char_properties_at_native(
        &self,
        sec_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
    ) -> Result<String, HwpError> {
        let para = self
            .get_cell_paragraph_ref(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )
            .ok_or_else(|| HwpError::RenderError("셀 문단을 찾을 수 없음".to_string()))?;
        Ok(self.build_char_properties_json(para, char_offset))
    }

    /// 캐럿 위치의 문단 속성 조회 (네이티브)
    pub fn get_para_properties_at_native(
        &self,
        sec_idx: usize,
        para_idx: usize,
    ) -> Result<String, HwpError> {
        use crate::model::control::Control;
        use crate::model::style::HeadType;
        let section = self
            .document
            .sections
            .get(sec_idx)
            .ok_or_else(|| HwpError::RenderError(format!("구역 {} 범위 초과", sec_idx)))?;
        let Some(para) = section.paragraphs.get(para_idx) else {
            if let Some(src) = self.virtual_endnote_para_source(sec_idx, para_idx) {
                return self.get_para_properties_in_footnote_native(
                    src.section_index,
                    src.para_index,
                    src.control_index,
                    src.note_para_index,
                );
            }
            return Err(HwpError::RenderError(format!(
                "문단 {} 범위 초과",
                para_idx
            )));
        };
        let mut json = self.build_para_properties_json(para.para_shape_id, sec_idx);

        // 번호 시작 방식 판별: numbering_id 패턴 기반
        let ps = self.styles.para_styles.get(para.para_shape_id as usize);
        let head_type = ps.map(|s| s.head_type).unwrap_or(HeadType::None);
        if head_type != HeadType::None {
            let cur_nid = ps.map(|s| s.numbering_id).unwrap_or(0);
            // NewNumber 컨트롤 체크
            let new_number = para.controls.iter().find_map(|c| {
                if let Control::NewNumber(nn) = c {
                    Some(nn.number)
                } else {
                    None
                }
            });
            let (mode, start_num) = if let Some(num) = new_number {
                (2, num as u32) // 새 번호 목록 시작 (NewNumber 컨트롤)
            } else {
                // 이전 번호 문단의 numbering_id를 역순 스캔
                let mut prev_nid: Option<u16> = None;
                let mut seen_before = false;
                for pi in (0..para_idx).rev() {
                    let pp = &section.paragraphs[pi];
                    let pps = self.styles.para_styles.get(pp.para_shape_id as usize);
                    let pht = pps.map(|s| s.head_type).unwrap_or(HeadType::None);
                    if pht == HeadType::None {
                        continue;
                    }
                    let pnid = pps.map(|s| s.numbering_id).unwrap_or(0);
                    if prev_nid.is_none() {
                        prev_nid = Some(pnid);
                    }
                    if pnid == cur_nid {
                        seen_before = true;
                        break;
                    }
                }
                match (prev_nid, seen_before) {
                    (Some(pid), _) if pid == cur_nid => (0, 1), // 앞 번호 이어
                    (_, true) => (1, 1),                        // 이전 번호 이어
                    _ => (2, 1),                                // 새 번호 시작
                }
            };
            json.pop(); // 마지막 '}' 제거
            json.push_str(&format!(
                ",\"numberingRestartMode\":{},\"numberingStartNum\":{}}}",
                mode, start_num
            ));
        }

        Ok(json)
    }

    fn virtual_endnote_para_source(
        &self,
        sec_idx: usize,
        para_idx: usize,
    ) -> Option<crate::renderer::pagination::EndnoteParaSource> {
        let body_len = self.document.sections.get(sec_idx)?.paragraphs.len();
        let local_idx = para_idx.checked_sub(body_len)?;
        self.pagination
            .get(sec_idx)?
            .endnote_para_sources
            .get(local_idx)
            .cloned()
    }

    /// 셀 내부 문단의 문단 속성 조회 (네이티브)
    pub fn get_cell_para_properties_at_native(
        &self,
        sec_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
    ) -> Result<String, HwpError> {
        let para = self
            .get_cell_paragraph_ref(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )
            .ok_or_else(|| HwpError::RenderError("셀 문단을 찾을 수 없음".to_string()))?;
        Ok(self.build_para_properties_json(para.para_shape_id, sec_idx))
    }

    /// 본문·표 셀·중첩 표 셀을 같은 cellPath 계약으로 조회한다.
    /// 빈 path는 본문 문단, 나머지는 `resolve_paragraph_by_path`가 가리키는 문단이다.
    pub fn get_para_properties_by_path_native(
        &self,
        sec_idx: usize,
        parent_para_idx: usize,
        cell_path: &[(usize, usize, usize)],
    ) -> Result<String, HwpError> {
        let para = self.resolve_control_para(sec_idx, parent_para_idx, cell_path)?;
        Ok(self.build_para_properties_json(para.para_shape_id, sec_idx))
    }

    fn check_state_for_para_shape(&self, para_shape_id: u16) -> Result<(bool, bool), HwpError> {
        use crate::model::style::HeadType;

        let para_shape = self
            .document
            .doc_info
            .para_shapes
            .get(para_shape_id as usize)
            .ok_or_else(|| HwpError::RenderError(format!(
                "문단 모양 ID {} 범위 초과",
                para_shape_id
            )))?;
        if para_shape.head_type != HeadType::Bullet || para_shape.numbering_id == 0 {
            return Ok((false, false));
        }
        let checkable = self
            .document
            .doc_info
            .bullets
            .get((para_shape.numbering_id - 1) as usize)
            .map(|bullet| bullet.check_bullet_char != '\0')
            .unwrap_or(false);
        let checked = checkable
            && matches!(para_shape.checked.as_deref(), Some("1" | "true" | "TRUE"));
        Ok((checkable, checked))
    }

    /// HWPX 네이티브 체크 글머리표의 문단별 상태를 바꾼다.
    ///
    /// ParaShape는 여러 문단이 공유하므로 원본 모양을 수정하지 않는다.
    /// `find_or_create_para_shape`로 checked만 다른 모양을 만들고 대상 문단의
    /// 참조만 바꾼다. `expected_checked`는 AI 제안을 기다리는 동안 사람이
    /// 직접 바꾼 상태를 덮지 않기 위한 낙관적 잠금이다.
    pub fn set_check_state_by_path_native(
        &mut self,
        sec_idx: usize,
        parent_para_idx: usize,
        cell_path: &[(usize, usize, usize)],
        expected_checked: bool,
        checked: bool,
    ) -> Result<String, HwpError> {
        let base_id = self
            .resolve_control_para(sec_idx, parent_para_idx, cell_path)?
            .para_shape_id;
        let (checkable, current) = self.check_state_for_para_shape(base_id)?;
        if !checkable {
            return Err(HwpError::RenderError("체크 가능한 글머리표가 아닙니다".to_string()));
        }
        if current != expected_checked {
            return Err(HwpError::RenderError(format!(
                "체크 상태 불일치: expected={}, actual={}",
                expected_checked, current
            )));
        }
        if current == checked {
            return Ok(format!("{{\"ok\":true,\"checked\":{}}}", checked));
        }

        let mods = crate::model::style::ParaShapeMods {
            checked: Some(checked),
            ..Default::default()
        };
        let new_id = self.document.find_or_create_para_shape(base_id, &mods);
        if cell_path.is_empty() {
            let para = self
                .document
                .sections
                .get_mut(sec_idx)
                .and_then(|section| section.paragraphs.get_mut(parent_para_idx))
                .ok_or_else(|| HwpError::RenderError("본문 문단을 찾을 수 없음".to_string()))?;
            para.para_shape_id = new_id;
        } else {
            self.get_cell_paragraph_mut_by_path(sec_idx, parent_para_idx, cell_path)?
                .para_shape_id = new_id;
            self.mark_cell_control_dirty(sec_idx, parent_para_idx, cell_path[0].0);
        }

        self.document.sections[sec_idx].raw_stream = None;
        self.rebuild_section(sec_idx);
        self.event_log.push(DocumentEvent::ParaFormatChanged {
            section: sec_idx,
            para: parent_para_idx,
        });
        Ok(format!(
            "{{\"ok\":true,\"checked\":{},\"paraShapeId\":{}}}",
            checked, new_id
        ))
    }

    /// 글자 속성 JSON 생성 헬퍼
    pub(crate) fn build_char_properties_json(
        &self,
        para: &crate::model::paragraph::Paragraph,
        char_offset: usize,
    ) -> String {
        let char_shape_id = para.char_shape_id_at(char_offset).unwrap_or(0);
        let style = self.styles.char_styles.get(char_shape_id as usize);

        match style {
            Some(cs) => {
                use crate::model::style::UnderlineType;
                use crate::renderer::style_resolver::detect_lang_category;

                // 캐럿 위치 문자의 언어 카테고리를 판별하여 해당 폰트 반환
                let lang_index = para
                    .text
                    .chars()
                    .nth(char_offset)
                    .map(|ch| detect_lang_category(ch))
                    .unwrap_or(0);
                let font_family_raw = cs.font_family_for_lang(lang_index);
                let font_family =
                    crate::renderer::style_resolver::primary_font_name(&font_family_raw);

                let escaped_font = super::super::helpers::json_escape(font_family);
                let underline = !matches!(cs.underline, UnderlineType::None);
                let underline_type_str = match cs.underline {
                    UnderlineType::None => "None",
                    UnderlineType::Bottom => "Bottom",
                    UnderlineType::Top => "Top",
                };

                // raw CharShape에서 추가 속성 읽기
                let raw_cs = self
                    .document
                    .doc_info
                    .char_shapes
                    .get(char_shape_id as usize);
                let base_size = raw_cs.map(|s| s.base_size).unwrap_or(1000);

                // 언어별 글꼴 이름 배열 (원본 폰트명만, 폴백 제외)
                let font_families: Vec<String> = (0..7usize)
                    .map(|i| {
                        let name = cs.font_family_for_lang(i);
                        let primary = crate::renderer::style_resolver::primary_font_name(&name);
                        super::super::helpers::json_escape(primary)
                    })
                    .collect();
                let font_families_json = format!(
                    "[{}]",
                    font_families
                        .iter()
                        .map(|f| format!("\"{}\"", f))
                        .collect::<Vec<_>>()
                        .join(",")
                );

                // 언어별 수치 배열
                let (ratios, spacings, relative_sizes, char_offsets) = match raw_cs {
                    Some(s) => (s.ratios, s.spacings, s.relative_sizes, s.char_offsets),
                    None => ([100u8; 7], [0i8; 7], [100u8; 7], [0i8; 7]),
                };
                let ratios_json = format!(
                    "[{}]",
                    ratios
                        .iter()
                        .map(|v| v.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                );
                let spacings_json = format!(
                    "[{}]",
                    spacings
                        .iter()
                        .map(|v| v.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                );
                let relative_sizes_json = format!(
                    "[{}]",
                    relative_sizes
                        .iter()
                        .map(|v| v.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                );
                let char_offsets_json = format!(
                    "[{}]",
                    char_offsets
                        .iter()
                        .map(|v| v.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                );

                let (
                    shadow_type,
                    shadow_color,
                    shadow_offset_x,
                    shadow_offset_y,
                    outline_type,
                    subscript,
                    superscript,
                    shade_color,
                    emboss,
                    engrave,
                    emphasis_dot,
                    underline_shape,
                    strike_shape,
                    kerning,
                ) = match raw_cs {
                    Some(s) => (
                        s.shadow_type,
                        s.shadow_color,
                        s.shadow_offset_x,
                        s.shadow_offset_y,
                        s.outline_type,
                        s.subscript,
                        s.superscript,
                        s.shade_color,
                        s.emboss,
                        s.engrave,
                        s.emphasis_dot,
                        s.underline_shape,
                        s.strike_shape,
                        s.kerning,
                    ),
                    None => (
                        0, 0xB2B2B2, 0i8, 0i8, 0, false, false, 0xFFFFFF, false, false, 0, 0, 0,
                        false,
                    ),
                };

                // 글자 테두리/배경 정보
                let border_fill_json = self.build_char_border_fill_json(raw_cs);

                format!(
                    concat!(
                        "{{\"fontFamily\":\"{}\",\"fontSize\":{},\"bold\":{},\"italic\":{},",
                        "\"underline\":{},\"underlineType\":\"{}\",\"underlineColor\":\"{}\",",
                        "\"strikethrough\":{},\"strikeColor\":\"{}\",",
                        "\"textColor\":\"{}\",\"shadeColor\":\"{}\",",
                        "\"shadowType\":{},\"shadowColor\":\"{}\",\"shadowOffsetX\":{},\"shadowOffsetY\":{},",
                        "\"outlineType\":{},",
                        "\"subscript\":{},\"superscript\":{},",
                        "\"emboss\":{},\"engrave\":{},",
                        "\"emphasisDot\":{},\"underlineShape\":{},\"strikeShape\":{},\"kerning\":{},",
                        "\"charShapeId\":{},",
                        "\"fontFamilies\":{},",
                        "\"ratios\":{},\"spacings\":{},\"relativeSizes\":{},\"charOffsets\":{},",
                        "{}",
                        "}}"
                    ),
                    escaped_font, base_size, cs.bold, cs.italic,
                    underline, underline_type_str, color_ref_to_css(cs.underline_color),
                    cs.strikethrough, color_ref_to_css(raw_cs.map(|s| s.strike_color).unwrap_or(0)),
                    color_ref_to_css(cs.text_color), color_ref_to_css(shade_color),
                    shadow_type, color_ref_to_css(shadow_color), shadow_offset_x, shadow_offset_y,
                    outline_type,
                    subscript, superscript,
                    emboss, engrave,
                    emphasis_dot, underline_shape, strike_shape, kerning,
                    char_shape_id,
                    font_families_json,
                    ratios_json, spacings_json, relative_sizes_json, char_offsets_json,
                    border_fill_json,
                )
            }
            None => {
                format!(
                    concat!(
                        "{{\"fontFamily\":\"sans-serif\",\"fontSize\":1000,\"bold\":false,\"italic\":false,",
                        "\"underline\":false,\"underlineType\":\"None\",\"underlineColor\":\"#000000\",",
                        "\"strikethrough\":false,\"strikeColor\":\"#000000\",",
                        "\"textColor\":\"#000000\",\"shadeColor\":\"#ffffff\",",
                        "\"shadowType\":0,\"shadowColor\":\"#b2b2b2\",\"shadowOffsetX\":0,\"shadowOffsetY\":0,",
                        "\"outlineType\":0,",
                        "\"subscript\":false,\"superscript\":false,",
                        "\"emboss\":false,\"engrave\":false,",
                        "\"emphasisDot\":0,\"underlineShape\":0,\"strikeShape\":0,\"kerning\":false,",
                        "\"charShapeId\":{},",
                        "\"fontFamilies\":[\"sans-serif\",\"sans-serif\",\"sans-serif\",\"sans-serif\",\"sans-serif\",\"sans-serif\",\"sans-serif\"],",
                        "\"ratios\":[100,100,100,100,100,100,100],\"spacings\":[0,0,0,0,0,0,0],",
                        "\"relativeSizes\":[100,100,100,100,100,100,100],\"charOffsets\":[0,0,0,0,0,0,0],",
                        "\"borderFillId\":0,",
                        "\"borderLeft\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"borderRight\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"borderTop\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"borderBottom\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"fillType\":\"none\",\"fillColor\":\"#ffffff\",\"patternColor\":\"#000000\",\"patternType\":0",
                        "}}"
                    ),
                    char_shape_id
                )
            }
        }
    }

    /// charShapeId로 직접 글자 속성 JSON을 빌드 (스타일 상세 조회용)
    pub(crate) fn build_char_properties_json_by_id(&self, char_shape_id: u16) -> String {
        let style = self.styles.char_styles.get(char_shape_id as usize);
        match style {
            Some(cs) => {
                use crate::model::style::UnderlineType;
                // 한글(0) 언어를 기본으로 사용
                let font_family_raw = cs.font_family_for_lang(0);
                let font_family =
                    crate::renderer::style_resolver::primary_font_name(&font_family_raw);
                let escaped_font = super::super::helpers::json_escape(font_family);
                let underline = !matches!(cs.underline, UnderlineType::None);
                let underline_type_str = match cs.underline {
                    UnderlineType::None => "None",
                    UnderlineType::Bottom => "Bottom",
                    UnderlineType::Top => "Top",
                };
                let raw_cs = self
                    .document
                    .doc_info
                    .char_shapes
                    .get(char_shape_id as usize);
                let base_size = raw_cs.map(|s| s.base_size).unwrap_or(1000);
                let font_families: Vec<String> = (0..7usize)
                    .map(|i| {
                        let name = cs.font_family_for_lang(i);
                        let primary = crate::renderer::style_resolver::primary_font_name(&name);
                        super::super::helpers::json_escape(primary)
                    })
                    .collect();
                let font_families_json = format!(
                    "[{}]",
                    font_families
                        .iter()
                        .map(|f| format!("\"{}\"", f))
                        .collect::<Vec<_>>()
                        .join(",")
                );
                let (ratios, spacings, relative_sizes, char_offsets) = match raw_cs {
                    Some(s) => (s.ratios, s.spacings, s.relative_sizes, s.char_offsets),
                    None => ([100u8; 7], [0i8; 7], [100u8; 7], [0i8; 7]),
                };
                let ratios_json = format!(
                    "[{}]",
                    ratios
                        .iter()
                        .map(|v| v.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                );
                let spacings_json = format!(
                    "[{}]",
                    spacings
                        .iter()
                        .map(|v| v.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                );
                let relative_sizes_json = format!(
                    "[{}]",
                    relative_sizes
                        .iter()
                        .map(|v| v.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                );
                let char_offsets_json = format!(
                    "[{}]",
                    char_offsets
                        .iter()
                        .map(|v| v.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                );
                let (
                    shadow_type,
                    shadow_color,
                    shadow_offset_x,
                    shadow_offset_y,
                    outline_type,
                    subscript,
                    superscript,
                    shade_color,
                    emboss,
                    engrave,
                    emphasis_dot,
                    underline_shape,
                    strike_shape,
                    kerning,
                ) = match raw_cs {
                    Some(s) => (
                        s.shadow_type,
                        s.shadow_color,
                        s.shadow_offset_x,
                        s.shadow_offset_y,
                        s.outline_type,
                        s.subscript,
                        s.superscript,
                        s.shade_color,
                        s.emboss,
                        s.engrave,
                        s.emphasis_dot,
                        s.underline_shape,
                        s.strike_shape,
                        s.kerning,
                    ),
                    None => (
                        0, 0xB2B2B2, 0i8, 0i8, 0, false, false, 0xFFFFFF, false, false, 0, 0, 0,
                        false,
                    ),
                };
                let border_fill_json = self.build_char_border_fill_json(raw_cs);
                format!(
                    concat!(
                        "{{\"fontFamily\":\"{}\",\"fontSize\":{},\"bold\":{},\"italic\":{},",
                        "\"underline\":{},\"underlineType\":\"{}\",\"underlineColor\":\"{}\",",
                        "\"strikethrough\":{},\"strikeColor\":\"{}\",",
                        "\"textColor\":\"{}\",\"shadeColor\":\"{}\",",
                        "\"shadowType\":{},\"shadowColor\":\"{}\",\"shadowOffsetX\":{},\"shadowOffsetY\":{},",
                        "\"outlineType\":{},",
                        "\"subscript\":{},\"superscript\":{},",
                        "\"emboss\":{},\"engrave\":{},",
                        "\"emphasisDot\":{},\"underlineShape\":{},\"strikeShape\":{},\"kerning\":{},",
                        "\"charShapeId\":{},",
                        "\"fontFamilies\":{},",
                        "\"ratios\":{},\"spacings\":{},\"relativeSizes\":{},\"charOffsets\":{},",
                        "{}",
                        "}}"
                    ),
                    escaped_font, base_size, cs.bold, cs.italic,
                    underline, underline_type_str, color_ref_to_css(cs.underline_color),
                    cs.strikethrough, color_ref_to_css(raw_cs.map(|s| s.strike_color).unwrap_or(0)),
                    color_ref_to_css(cs.text_color), color_ref_to_css(shade_color),
                    shadow_type, color_ref_to_css(shadow_color), shadow_offset_x, shadow_offset_y,
                    outline_type,
                    subscript, superscript,
                    emboss, engrave,
                    emphasis_dot, underline_shape, strike_shape, kerning,
                    char_shape_id,
                    font_families_json,
                    ratios_json, spacings_json, relative_sizes_json, char_offsets_json,
                    border_fill_json,
                )
            }
            None => {
                format!(
                    concat!(
                        "{{\"fontFamily\":\"sans-serif\",\"fontSize\":1000,\"bold\":false,\"italic\":false,",
                        "\"underline\":false,\"underlineType\":\"None\",\"underlineColor\":\"#000000\",",
                        "\"strikethrough\":false,\"strikeColor\":\"#000000\",",
                        "\"textColor\":\"#000000\",\"shadeColor\":\"#ffffff\",",
                        "\"shadowType\":0,\"shadowColor\":\"#b2b2b2\",\"shadowOffsetX\":0,\"shadowOffsetY\":0,",
                        "\"outlineType\":0,",
                        "\"subscript\":false,\"superscript\":false,",
                        "\"emboss\":false,\"engrave\":false,",
                        "\"emphasisDot\":0,\"underlineShape\":0,\"strikeShape\":0,\"kerning\":false,",
                        "\"charShapeId\":{},",
                        "\"fontFamilies\":[\"sans-serif\",\"sans-serif\",\"sans-serif\",\"sans-serif\",\"sans-serif\",\"sans-serif\",\"sans-serif\"],",
                        "\"ratios\":[100,100,100,100,100,100,100],\"spacings\":[0,0,0,0,0,0,0],",
                        "\"relativeSizes\":[100,100,100,100,100,100,100],\"charOffsets\":[0,0,0,0,0,0,0],",
                        "\"borderFillId\":0,",
                        "\"borderLeft\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"borderRight\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"borderTop\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"borderBottom\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"fillType\":\"none\",\"fillColor\":\"#ffffff\",\"patternColor\":\"#000000\",\"patternType\":0",
                        "}}"
                    ),
                    char_shape_id
                )
            }
        }
    }

    /// 글자 테두리/배경 JSON 헬퍼 — CharShape의 border_fill_id를 참조하여 BorderFill 정보를 JSON 문자열로 반환
    pub(crate) fn build_char_border_fill_json(
        &self,
        raw_cs: Option<&crate::model::style::CharShape>,
    ) -> String {
        let bf_id = raw_cs.map(|s| s.border_fill_id).unwrap_or(0);
        if bf_id == 0 {
            return concat!(
                "\"borderFillId\":0,",
                "\"borderLeft\":{\"type\":0,\"width\":0,\"color\":\"#000000\"},",
                "\"borderRight\":{\"type\":0,\"width\":0,\"color\":\"#000000\"},",
                "\"borderTop\":{\"type\":0,\"width\":0,\"color\":\"#000000\"},",
                "\"borderBottom\":{\"type\":0,\"width\":0,\"color\":\"#000000\"},",
                "\"fillType\":\"none\",\"fillColor\":\"#ffffff\",\"patternColor\":\"#000000\",\"patternType\":0"
            ).to_string();
        }
        let bf = self
            .document
            .doc_info
            .border_fills
            .get((bf_id - 1) as usize);
        match bf {
            Some(bf) => {
                use crate::model::style::FillType;
                let dir_names = ["Left", "Right", "Top", "Bottom"];
                let borders_json: Vec<String> = bf.borders.iter().enumerate().map(|(i, b)| {
                    format!(
                        "\"border{}\":{{\"type\":{},\"width\":{},\"color\":\"{}\"}}",
                        dir_names[i],
                        border_line_type_to_u8_val(b.line_type),
                        b.width,
                        color_ref_to_css(b.color),
                    )
                }).collect();
                let (fill_type_str, fill_color, pat_color, pat_type) = match &bf.fill.solid {
                    Some(sf) if bf.fill.fill_type == FillType::Solid => {
                        ("solid", color_ref_to_css(sf.background_color),
                         color_ref_to_css(sf.pattern_color), sf.pattern_type)
                    }
                    _ => ("none", "#ffffff".to_string(), "#000000".to_string(), 0),
                };
                format!(
                    "\"borderFillId\":{},{},\"fillType\":\"{}\",\"fillColor\":\"{}\",\"patternColor\":\"{}\",\"patternType\":{}",
                    bf_id,
                    borders_json.join(","),
                    fill_type_str, fill_color, pat_color, pat_type,
                )
            }
            None => {
                concat!(
                    "\"borderFillId\":0,",
                    "\"borderLeft\":{\"type\":0,\"width\":0,\"color\":\"#000000\"},",
                    "\"borderRight\":{\"type\":0,\"width\":0,\"color\":\"#000000\"},",
                    "\"borderTop\":{\"type\":0,\"width\":0,\"color\":\"#000000\"},",
                    "\"borderBottom\":{\"type\":0,\"width\":0,\"color\":\"#000000\"},",
                    "\"fillType\":\"none\",\"fillColor\":\"#ffffff\",\"patternColor\":\"#000000\",\"patternType\":0"
                ).to_string()
            }
        }
    }

    /// 문단 속성 JSON 생성 헬퍼
    pub(crate) fn build_para_properties_json(&self, para_shape_id: u16, sec_idx: usize) -> String {
        use crate::model::style::{Alignment, FillType, HeadType};
        let ps = self.styles.para_styles.get(para_shape_id as usize);

        // 탭 정의 조회
        let raw_ps = self
            .document
            .doc_info
            .para_shapes
            .get(para_shape_id as usize);
        let tab_def_id = raw_ps.map(|p| p.tab_def_id).unwrap_or(0);
        let tab_def = self.document.doc_info.tab_defs.get(tab_def_id as usize);
        let tab_auto_left = tab_def.map(|td| td.auto_tab_left).unwrap_or(false);
        let tab_auto_right = tab_def.map(|td| td.auto_tab_right).unwrap_or(false);
        let tab_stops_json = tab_def
            .map(|td| {
                td.tabs
                    .iter()
                    .map(|t| {
                        format!(
                            "{{\"position\":{},\"type\":{},\"fill\":{}}}",
                            t.position, t.tab_type, t.fill_type
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        let default_tab_spacing = self
            .document
            .sections
            .get(sec_idx)
            .map(|s| s.section_def.default_tab_spacing)
            .unwrap_or(4000);

        // 체크 가능한 글머리표는 일반 Bullet과 같은 numbering_id를 쓰되
        // Bullet 정의에 checkedChar가 있다. 선택 상태는 각 ParaShape의
        // paraPr@checked에 있으므로 둘을 함께 봐야 한다.
        let bullet = ps.and_then(|resolved| {
            if resolved.head_type != HeadType::Bullet || resolved.numbering_id == 0 {
                return None;
            }
            self.document
                .doc_info
                .bullets
                .get((resolved.numbering_id - 1) as usize)
        });
        let checkable = bullet
            .map(|item| item.check_bullet_char != '\0')
            .unwrap_or(false);
        let checked = checkable
            && matches!(raw_ps.and_then(|item| item.checked.as_deref()), Some("1" | "true" | "TRUE"));
        let bullet_char = bullet
            .map(|item| json_escape(&item.bullet_char.to_string()))
            .unwrap_or_default();
        let checked_char = bullet
            .filter(|_| checkable)
            .map(|item| json_escape(&item.check_bullet_char.to_string()))
            .unwrap_or_default();

        // 테두리/배경 조회
        let bf_id = raw_ps.map(|p| p.border_fill_id).unwrap_or(0);
        let border_spacing = raw_ps.map(|p| p.border_spacing).unwrap_or([0; 4]);
        let border_fill_json = if bf_id > 0 {
            if let Some(bf) = self
                .document
                .doc_info
                .border_fills
                .get((bf_id - 1) as usize)
            {
                let dir_names = ["Left", "Right", "Top", "Bottom"];
                let borders: Vec<String> = bf
                    .borders
                    .iter()
                    .enumerate()
                    .map(|(i, b)| {
                        format!(
                            "\"border{}\":{{\"type\":{},\"width\":{},\"color\":\"{}\"}}",
                            dir_names[i],
                            border_line_type_to_u8_val(b.line_type),
                            b.width,
                            color_ref_to_css(b.color),
                        )
                    })
                    .collect();
                let (fill_type_str, fill_color, pat_color, pat_type) = match &bf.fill.solid {
                    Some(sf) if bf.fill.fill_type == FillType::Solid => (
                        "solid",
                        color_ref_to_css(sf.background_color),
                        color_ref_to_css(sf.pattern_color),
                        sf.pattern_type,
                    ),
                    _ => ("none", "#ffffff".to_string(), "#000000".to_string(), 0),
                };
                format!(
                    "\"borderFillId\":{},{},\"fillType\":\"{}\",\"fillColor\":\"{}\",\"patternColor\":\"{}\",\"patternType\":{}",
                    bf_id, borders.join(","), fill_type_str, fill_color, pat_color, pat_type,
                )
            } else {
                format!(
                    concat!(
                        "\"borderFillId\":0,",
                        "\"borderLeft\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"borderRight\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"borderTop\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"borderBottom\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"fillType\":\"none\",\"fillColor\":\"#ffffff\",\"patternColor\":\"#000000\",\"patternType\":0"
                    )
                )
            }
        } else {
            format!(
                concat!(
                    "\"borderFillId\":0,",
                    "\"borderLeft\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                    "\"borderRight\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                    "\"borderTop\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                    "\"borderBottom\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                    "\"fillType\":\"none\",\"fillColor\":\"#ffffff\",\"patternColor\":\"#000000\",\"patternType\":0"
                )
            )
        };

        // [Task #1037 + para-unit regression] dialog 표시 한컴 정합:
        // - margin/indent 는 raw_ps 직접 사용 (variant_div 미적용)
        // - HWP3 native 만 raw margin_left 가 continuation 라인 position 이므로
        //   한컴 dialog "왼쪽 여백" 을 effective first-line position 으로 보정한다.
        // - HWP5/HWPX 및 HWP3→HWP5 변환본은 raw margin_left 가 dialog 의 왼쪽 여백 의미다.
        let (raw_left_hu, raw_right_hu, raw_indent_hu) = raw_ps
            .map(|r| (r.margin_left, r.margin_right, r.indent))
            .unwrap_or((0, 0, 0));
        let is_hwp3_native =
            self.document.header.version.major == 3 && !self.document.is_hwp3_variant;
        let effective_left_hu = if is_hwp3_native {
            raw_left_hu + raw_indent_hu.min(0)
        } else {
            raw_left_hu
        };
        // [Issue #1172] ParaShape margin/indent 의 IR 값은 2× 스케일이다
        // (HWP5 바이너리 원본 스케일, HWPX 도 parser 의 val2x 로 통일 — header.rs).
        // 즉 1pt = 200 HWPUNIT. 한컴 편집기 정답: para-001 margin 2000 → 10.0pt.
        // dialog 표시(px→pt by frontend pxToPt)와 정합하려면 표준 hwpunit_to_px(7200/inch,
        // 1× 가정) 적용 전에 2× 스케일을 1× 로 환산(÷2)해야 한다. (종전: ÷2 누락 → 2배 표시)
        let dialog_margin_left_px = crate::renderer::hwpunit_to_px(effective_left_hu / 2, self.dpi);
        let dialog_margin_right_px = crate::renderer::hwpunit_to_px(raw_right_hu / 2, self.dpi);
        let dialog_indent_px = crate::renderer::hwpunit_to_px(raw_indent_hu / 2, self.dpi);

        match ps {
            Some(ps) => {
                let align_str = match ps.alignment {
                    Alignment::Justify => "justify",
                    Alignment::Left => "left",
                    Alignment::Right => "right",
                    Alignment::Center => "center",
                    Alignment::Distribute => "distribute",
                    Alignment::Split => "split",
                };
                let head_str = match ps.head_type {
                    HeadType::None => "None",
                    HeadType::Outline => "Outline",
                    HeadType::Number => "Number",
                    HeadType::Bullet => "Bullet",
                };
                // 원본 ParaShape에서 attr 비트 추출
                let (a1, a2) = raw_ps.map(|r| (r.attr1, r.attr2)).unwrap_or((0, 0));
                // 바이너리: attr1, HWPX: attr2 — OR 조합으로 양쪽 지원
                let widow_orphan = ((a1 >> 16) & 1 != 0) || ((a2 >> 5) & 1 != 0);
                let keep_with_next = ((a1 >> 17) & 1 != 0) || ((a2 >> 6) & 1 != 0);
                let keep_lines = ((a1 >> 18) & 1 != 0) || ((a2 >> 7) & 1 != 0);
                let page_break_before = ((a1 >> 19) & 1 != 0) || ((a2 >> 8) & 1 != 0);
                let font_line_height = (a1 >> 22) & 1 != 0;
                let single_line = (a2 & 0x03) != 0;
                let auto_space_kr_en = ((a2 >> 4) & 1 != 0) || ((a1 >> 20) & 1 != 0);
                let auto_space_kr_num = ((a2 >> 5) & 1 != 0) || ((a1 >> 21) & 1 != 0);
                // verticalAlign: attr1 bits 20-21 (autoSpacing과 충돌 시 0)
                let vertical_align = if !auto_space_kr_en && !auto_space_kr_num {
                    (a1 >> 20) & 0x03
                } else {
                    0
                };
                let english_break_unit = (a1 >> 5) & 0x03;
                let korean_break_unit = (a1 >> 7) & 0x01;
                let border_connect = (a1 >> 28) & 1 != 0;
                let border_ignore_margin = (a1 >> 29) & 1 != 0;
                format!(
                    concat!(
                        "{{\"alignment\":\"{}\",\"lineSpacing\":{:.1},\"lineSpacingType\":\"{:?}\",",
                        "\"marginLeft\":{:.1},\"marginRight\":{:.1},\"indent\":{:.1},",
                        "\"spacingBefore\":{:.1},\"spacingAfter\":{:.1},\"paraShapeId\":{},",
                        "\"headType\":\"{}\",\"paraLevel\":{},\"numberingId\":{},",
                        "\"checkable\":{},\"checked\":{},\"bulletChar\":\"{}\",\"checkedChar\":\"{}\",",
                        "\"widowOrphan\":{},\"keepWithNext\":{},\"keepLines\":{},\"pageBreakBefore\":{},",
                        "\"fontLineHeight\":{},\"singleLine\":{},",
                        "\"autoSpaceKrEn\":{},\"autoSpaceKrNum\":{},\"verticalAlign\":{},",
                        "\"englishBreakUnit\":{},\"koreanBreakUnit\":{},",
                        "\"tabAutoLeft\":{},\"tabAutoRight\":{},\"tabStops\":[{}],\"defaultTabSpacing\":{},",
                        "{},\"borderSpacing\":[{},{},{},{}],",
                        "\"borderConnect\":{},\"borderIgnoreMargin\":{}}}"
                    ),
                    align_str,
                    ps.line_spacing, ps.line_spacing_type,
                    dialog_margin_left_px, dialog_margin_right_px, dialog_indent_px,
                    // spacing_before/after는 원본 HWPUNIT → px (1x) 변환 (Task #9)
                    // ResolvedParaStyle은 /2.0이 적용되어 UI 표시에 부적합
                    raw_ps.map(|r| crate::renderer::hwpunit_to_px(r.spacing_before, self.dpi)).unwrap_or(ps.spacing_before),
                    raw_ps.map(|r| crate::renderer::hwpunit_to_px(r.spacing_after, self.dpi)).unwrap_or(ps.spacing_after),
                    para_shape_id,
                    head_str, ps.para_level, ps.numbering_id,
                    checkable, checked, bullet_char, checked_char,
                    widow_orphan, keep_with_next, keep_lines, page_break_before,
                    font_line_height, single_line,
                    auto_space_kr_en, auto_space_kr_num, vertical_align,
                    english_break_unit, korean_break_unit,
                    tab_auto_left, tab_auto_right, tab_stops_json, default_tab_spacing,
                    border_fill_json,
                    border_spacing[0], border_spacing[1], border_spacing[2], border_spacing[3],
                    border_connect, border_ignore_margin,
                )
            }
            None => {
                format!(
                    concat!(
                        "{{\"alignment\":\"justify\",\"lineSpacing\":160.0,\"lineSpacingType\":\"Percent\",",
                        "\"marginLeft\":0.0,\"marginRight\":0.0,\"indent\":0.0,",
                        "\"spacingBefore\":0.0,\"spacingAfter\":0.0,\"paraShapeId\":{},",
                        "\"headType\":\"None\",\"paraLevel\":0,\"numberingId\":0,",
                        "\"checkable\":false,\"checked\":false,\"bulletChar\":\"\",\"checkedChar\":\"\",",
                        "\"widowOrphan\":false,\"keepWithNext\":false,\"keepLines\":false,\"pageBreakBefore\":false,",
                        "\"fontLineHeight\":false,\"singleLine\":false,",
                        "\"autoSpaceKrEn\":false,\"autoSpaceKrNum\":false,\"verticalAlign\":0,",
                        "\"englishBreakUnit\":0,\"koreanBreakUnit\":0,",
                        "\"tabAutoLeft\":false,\"tabAutoRight\":false,\"tabStops\":[],\"defaultTabSpacing\":{},",
                        "\"borderFillId\":0,",
                        "\"borderLeft\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"borderRight\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"borderTop\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"borderBottom\":{{\"type\":0,\"width\":0,\"color\":\"#000000\"}},",
                        "\"fillType\":\"none\",\"fillColor\":\"#ffffff\",\"patternColor\":\"#000000\",\"patternType\":0,",
                        "\"borderSpacing\":[0,0,0,0],",
                        "\"borderConnect\":false,\"borderIgnoreMargin\":false}}"
                    ),
                    para_shape_id, default_tab_spacing
                )
            }
        }
    }

    /// 글꼴 이름으로 font_id를 조회하거나 새로 생성한다 (네이티브).
    pub fn find_or_create_font_id_native(&mut self, name: &str) -> i32 {
        let font_faces = &self.document.doc_info.font_faces;

        // 한글(0번) 카테고리에서 검색
        if !font_faces.is_empty() {
            for (idx, font) in font_faces[0].iter().enumerate() {
                if font.name == name {
                    return idx as i32;
                }
            }
        }

        // 없으면 7개 전체 카테고리에 동일 이름으로 신규 등록
        let new_font = crate::model::style::Font {
            raw_data: None,
            name: name.to_string(),
            alt_type: 0,
            is_embedded: false,
            bin_item_id_ref: String::new(),
            resolved_bin_data_id: None,
            alt_name: None,
            type_info: None,
            default_name: None,
            subst_font: None,
        };

        let font_faces = &mut self.document.doc_info.font_faces;
        // font_faces가 7개 미만이면 확장
        while font_faces.len() < 7 {
            font_faces.push(Vec::new());
        }

        let new_id = font_faces[0].len();
        for lang in 0..7 {
            font_faces[lang].push(new_font.clone());
        }

        // raw_stream 보존: 7개 언어 카테고리에 FACE_NAME surgical insert
        if let Some(ref mut raw) = self.document.doc_info.raw_stream {
            let face_data = crate::serializer::doc_info::serialize_face_name(&new_font);
            let _ = crate::serializer::doc_info::surgical_insert_font_all_langs(raw, &face_data);
        }
        new_id as i32
    }

    /// 특정 언어 카테고리에서 글꼴 이름으로 ID를 찾거나, 없으면 해당 카테고리에만 등록한다.
    pub fn find_or_create_font_id_for_lang(&mut self, lang: usize, name: &str) -> i32 {
        if lang >= 7 {
            return -1;
        }
        let font_faces = &self.document.doc_info.font_faces;
        if font_faces.len() <= lang {
            return -1;
        }

        // 해당 언어 카테고리에서 검색
        for (idx, font) in font_faces[lang].iter().enumerate() {
            if font.name == name {
                return idx as i32;
            }
        }

        // 없으면 해당 카테고리에만 등록 (다른 언어 카테고리 font_faces 길이 맞추기)
        let new_font = crate::model::style::Font {
            raw_data: None,
            name: name.to_string(),
            alt_type: 0,
            is_embedded: false,
            bin_item_id_ref: String::new(),
            resolved_bin_data_id: None,
            alt_name: None,
            type_info: None,
            default_name: None,
            subst_font: None,
        };

        let font_faces = &mut self.document.doc_info.font_faces;
        while font_faces.len() < 7 {
            font_faces.push(Vec::new());
        }

        // 모든 카테고리의 길이를 맞추기 위해 전체에 등록
        let new_id = font_faces[lang].len();
        for l in 0..7 {
            if l == lang {
                font_faces[l].push(new_font.clone());
            } else {
                // 다른 카테고리에는 placeholder 등록 (길이 동기화)
                let placeholder = if !font_faces[l].is_empty() {
                    // 첫 번째 폰트를 복제 (기본 글꼴)
                    font_faces[l][0].clone()
                } else {
                    new_font.clone()
                };
                font_faces[l].push(placeholder);
            }
        }

        // raw_stream 보존
        if let Some(ref mut raw) = self.document.doc_info.raw_stream {
            let face_data = crate::serializer::doc_info::serialize_face_name(&new_font);
            let _ = crate::serializer::doc_info::surgical_insert_font_all_langs(raw, &face_data);
        }
        new_id as i32
    }

    /// 글자 서식 적용 (네이티브) — 본문 문단
    pub fn apply_char_format_native(
        &mut self,
        sec_idx: usize,
        para_idx: usize,
        start_offset: usize,
        end_offset: usize,
        props_json: &str,
    ) -> Result<String, HwpError> {
        if sec_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!("구역 {} 범위 초과", sec_idx)));
        }
        if para_idx >= self.document.sections[sec_idx].paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 {} 범위 초과",
                para_idx
            )));
        }

        let mut mods = parse_char_shape_mods(props_json);
        // border/fill JSON이 있으면 BorderFill 생성/재사용하여 border_fill_id 설정
        if json_has_border_keys(props_json) {
            let bf_id = self.create_border_fill_from_json(props_json);
            mods.border_fill_id = Some(bf_id);
        }
        self.apply_char_mods_to_paragraph(sec_idx, para_idx, start_offset, end_offset, &mods);

        // 텍스트 폭/높이에 영향을 주는 글자 모양 변경 시 LineSeg 재계산.
        // 장평/자간은 글꼴 크기처럼 줄나눔과 페이지네이션을 바꾼다.
        if char_shape_mods_affect_text_flow(&mods) {
            let styles = resolve_styles(&self.document.doc_info, self.dpi);
            let section = &self.document.sections[sec_idx];
            let page_def = &section.section_def.page_def;
            let column_def = DocumentCore::find_initial_column_def(&section.paragraphs);
            let layout = PageLayoutInfo::from_page_def(page_def, &column_def, self.dpi);
            let col_width = layout
                .column_areas
                .first()
                .map(|a| a.width)
                .unwrap_or(layout.body_area.width);
            let para_shape_id = self.document.sections[sec_idx].paragraphs[para_idx].para_shape_id;
            let para_style = styles.para_styles.get(para_shape_id as usize);
            let margin_left = para_style.map(|s| s.margin_left).unwrap_or(0.0);
            let margin_right = para_style.map(|s| s.margin_right).unwrap_or(0.0);
            let available_width = (col_width - margin_left - margin_right).max(1.0);
            // 원본 LineSeg 무효화 → reflow가 max_font_size에서 새로 계산
            self.document.sections[sec_idx].paragraphs[para_idx]
                .line_segs
                .clear();
            reflow_line_segs(
                &mut self.document.sections[sec_idx].paragraphs[para_idx],
                available_width,
                &styles,
                self.dpi,
            );
        }

        self.document.sections[sec_idx].raw_stream = None;
        self.rebuild_section(sec_idx);
        self.event_log.push(DocumentEvent::CharFormatChanged {
            section: sec_idx,
            para: para_idx,
            start: start_offset,
            end: end_offset,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 글자 서식 ID 직접 복원 (네이티브) — 본문 문단.
    ///
    /// Undo/Redo에서는 `CharProperties` JSON을 다시 적용하지 않고, 적용 전/후
    /// `char_shape_id`를 직접 복원한다. 조회 JSON은 UI 상태 표현용 값이 섞여
    /// 있으므로 history 복원 payload로 재해석하지 않는다.
    pub fn set_char_shape_id_native(
        &mut self,
        sec_idx: usize,
        para_idx: usize,
        start_offset: usize,
        end_offset: usize,
        char_shape_id: u32,
    ) -> Result<String, HwpError> {
        if sec_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!("구역 {} 범위 초과", sec_idx)));
        }
        if para_idx >= self.document.sections[sec_idx].paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 {} 범위 초과",
                para_idx
            )));
        }
        if char_shape_id as usize >= self.document.doc_info.char_shapes.len() {
            return Err(HwpError::RenderError(format!(
                "글자 모양 ID {} 범위 초과 (총 {}개)",
                char_shape_id,
                self.document.doc_info.char_shapes.len()
            )));
        }

        let styles = resolve_styles(&self.document.doc_info, self.dpi);
        let available_width = {
            let section = &self.document.sections[sec_idx];
            let page_def = &section.section_def.page_def;
            let column_def = DocumentCore::find_initial_column_def(&section.paragraphs);
            let layout = PageLayoutInfo::from_page_def(page_def, &column_def, self.dpi);
            let col_width = layout
                .column_areas
                .first()
                .map(|a| a.width)
                .unwrap_or(layout.body_area.width);
            let para_shape_id = section.paragraphs[para_idx].para_shape_id;
            let para_style = styles.para_styles.get(para_shape_id as usize);
            let margin_left = para_style.map(|s| s.margin_left).unwrap_or(0.0);
            let margin_right = para_style.map(|s| s.margin_right).unwrap_or(0.0);
            (col_width - margin_left - margin_right).max(1.0)
        };

        {
            let para = &mut self.document.sections[sec_idx].paragraphs[para_idx];
            para.apply_char_shape_range(start_offset, end_offset, char_shape_id);
            reflow_line_segs(para, available_width, &styles, self.dpi);
        }

        self.document.sections[sec_idx].raw_stream = None;
        self.rebuild_section(sec_idx);
        self.event_log.push(DocumentEvent::CharFormatChanged {
            section: sec_idx,
            para: para_idx,
            start: start_offset,
            end: end_offset,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 글자 서식 적용 (네이티브) — 셀 내 문단
    pub fn apply_char_format_in_cell_native(
        &mut self,
        sec_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        start_offset: usize,
        end_offset: usize,
        props_json: &str,
    ) -> Result<String, HwpError> {
        let mut mods = parse_char_shape_mods(props_json);
        if json_has_border_keys(props_json) {
            let bf_id = self.create_border_fill_from_json(props_json);
            mods.border_fill_id = Some(bf_id);
        }

        // 셀 내 문단의 기존 char_shape_id를 기반으로 새 ID 생성
        {
            let para = self
                .get_cell_paragraph_ref(
                    sec_idx,
                    parent_para_idx,
                    control_idx,
                    cell_idx,
                    cell_para_idx,
                )
                .ok_or_else(|| HwpError::RenderError("셀 문단을 찾을 수 없음".to_string()))?;
            let base_id = para.char_shape_id_at(start_offset).unwrap_or(0);
            let new_id = self.document.find_or_create_char_shape(base_id, &mods);

            // 셀 문단에 범위 적용
            let cell_para = self.get_cell_paragraph_mut(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )?;
            if cell_para.text.is_empty() {
                // 빈 문단(빈 셀): 글자 범위가 없어 apply_char_shape_range 는 아무것도 안 한다.
                // 한컴은 빈 셀을 블록 선택해 글꼴·크기를 바꾸면 그 셀에 "다음에 입력할 글자"가 새
                // 모양으로 나오고 빈 줄 높이도 따라간다 — 문단의 유일한 CharShapeRef(문단 끝 문자의
                // 글자 모양)를 새 ID 로 바꾼다. 컨트롤만 있는 문단은 text 가 비지 않으므로 종전대로.
                cell_para.set_single_char_shape(new_id);
            } else {
                cell_para.apply_char_shape_range(start_offset, end_offset, new_id);
            }
        }

        // 텍스트 폭/높이에 영향을 주는 글자 모양 변경 시 셀 내 LineSeg 재계산.
        if char_shape_mods_affect_text_flow(&mods) {
            let dpi = self.dpi;
            let styles = resolve_styles(&self.document.doc_info, dpi);
            let section = &self.document.sections[sec_idx];
            let page_def = &section.section_def.page_def;
            let column_def = DocumentCore::find_initial_column_def(&section.paragraphs);
            let layout = PageLayoutInfo::from_page_def(page_def, &column_def, dpi);
            let col_width = layout
                .column_areas
                .first()
                .map(|a| a.width)
                .unwrap_or(layout.body_area.width);
            let cell_para = self.get_cell_paragraph_mut(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )?;
            let para_shape_id = cell_para.para_shape_id;
            let para_style = styles.para_styles.get(para_shape_id as usize);
            let margin_left = para_style.map(|s| s.margin_left).unwrap_or(0.0);
            let margin_right = para_style.map(|s| s.margin_right).unwrap_or(0.0);
            let available_width = (col_width - margin_left - margin_right).max(1.0);
            cell_para.line_segs.clear();
            reflow_line_segs(cell_para, available_width, &styles, dpi);

            // 표 dirty 마킹 — 셀 높이 재계산 필요
            if let Control::Table(ref mut t) =
                self.document.sections[sec_idx].paragraphs[parent_para_idx].controls[control_idx]
            {
                t.dirty = true;
            }
        }

        self.document.sections[sec_idx].raw_stream = None;
        self.rebuild_section(sec_idx);
        self.event_log.push(DocumentEvent::CharFormatChanged {
            section: sec_idx,
            para: parent_para_idx,
            start: start_offset,
            end: end_offset,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 글자 서식 ID 직접 복원 (네이티브) — 셀 내 문단.
    pub fn set_char_shape_id_in_cell_native(
        &mut self,
        sec_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        start_offset: usize,
        end_offset: usize,
        char_shape_id: u32,
    ) -> Result<String, HwpError> {
        if char_shape_id as usize >= self.document.doc_info.char_shapes.len() {
            return Err(HwpError::RenderError(format!(
                "글자 모양 ID {} 범위 초과 (총 {}개)",
                char_shape_id,
                self.document.doc_info.char_shapes.len()
            )));
        }

        {
            let cell_para = self.get_cell_paragraph_mut(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )?;
            cell_para.apply_char_shape_range(start_offset, end_offset, char_shape_id);
        }

        self.reflow_cell_paragraph(
            sec_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        );
        self.mark_cell_control_dirty(sec_idx, parent_para_idx, control_idx);
        self.document.sections[sec_idx].raw_stream = None;
        self.rebuild_section(sec_idx);
        self.event_log.push(DocumentEvent::CharFormatChanged {
            section: sec_idx,
            para: parent_para_idx,
            start: start_offset,
            end: end_offset,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 문단 서식 적용 (네이티브) — 본문 문단
    pub fn apply_para_format_native(
        &mut self,
        sec_idx: usize,
        para_idx: usize,
        props_json: &str,
    ) -> Result<String, HwpError> {
        if sec_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!("구역 {} 범위 초과", sec_idx)));
        }
        if para_idx >= self.document.sections[sec_idx].paragraphs.len() {
            if let Some(src) = self.virtual_endnote_para_source(sec_idx, para_idx) {
                return self.apply_para_format_in_footnote_native(
                    src.section_index,
                    src.para_index,
                    src.control_index,
                    src.note_para_index,
                    props_json,
                );
            }
            return Err(HwpError::RenderError(format!(
                "문단 {} 범위 초과",
                para_idx
            )));
        }

        let mut mods = parse_para_shape_mods(props_json);

        // 탭 설정 변경 처리: TabDef 생성 → tab_def_id 세팅
        if json_has_tab_keys(props_json) {
            let base_id = self.document.sections[sec_idx].paragraphs[para_idx].para_shape_id;
            let base_tab_def_id = self
                .document
                .doc_info
                .para_shapes
                .get(base_id as usize)
                .map(|ps| ps.tab_def_id)
                .unwrap_or(0);
            let new_td = build_tab_def_from_json(
                props_json,
                base_tab_def_id,
                &self.document.doc_info.tab_defs,
            );
            let new_tab_id = self.document.find_or_create_tab_def(new_td);
            mods.tab_def_id = Some(new_tab_id);
        }

        // 테두리/배경 변경 처리: BorderFill 생성 → border_fill_id 세팅
        if json_has_border_keys(props_json) {
            let bf_id = self.create_border_fill_from_json(props_json);
            mods.border_fill_id = Some(bf_id);
        }
        if let Some(arr) = parse_json_i16_array(props_json, "borderSpacing", 4) {
            mods.border_spacing = Some([arr[0], arr[1], arr[2], arr[3]]);
        }

        let base_id = self.document.sections[sec_idx].paragraphs[para_idx].para_shape_id;
        let new_id = self.document.find_or_create_para_shape(base_id, &mods);
        self.document.sections[sec_idx].paragraphs[para_idx].para_shape_id = new_id;

        // 줄간격 변경 시 LineSeg 재계산 (compose는 LineSeg 값을 그대로 사용하므로)
        if mods.line_spacing.is_some() || mods.line_spacing_type.is_some() {
            let styles = resolve_styles(&self.document.doc_info, self.dpi);
            let section = &self.document.sections[sec_idx];
            let page_def = &section.section_def.page_def;
            let column_def = DocumentCore::find_initial_column_def(&section.paragraphs);
            let layout = PageLayoutInfo::from_page_def(page_def, &column_def, self.dpi);
            let col_width = layout
                .column_areas
                .first()
                .map(|a| a.width)
                .unwrap_or(layout.body_area.width);
            let para_style = styles.para_styles.get(new_id as usize);
            let margin_left = para_style.map(|s| s.margin_left).unwrap_or(0.0);
            let margin_right = para_style.map(|s| s.margin_right).unwrap_or(0.0);
            let available_width = (col_width - margin_left - margin_right).max(1.0);
            reflow_line_segs(
                &mut self.document.sections[sec_idx].paragraphs[para_idx],
                available_width,
                &styles,
                self.dpi,
            );
        }

        self.document.sections[sec_idx].raw_stream = None;
        self.rebuild_section(sec_idx);
        self.event_log.push(DocumentEvent::ParaFormatChanged {
            section: sec_idx,
            para: para_idx,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 문단 서식 ID 직접 복원 (네이티브) — 본문 문단.
    ///
    /// Undo/Redo에서는 `ParaProperties` JSON을 다시 적용하지 않고, 적용 전/후
    /// `para_shape_id`를 직접 복원한다. 조회 JSON은 UI용 px 단위가 섞여 있어
    /// raw 값을 기대하는 apply parser에 재투입하면 단위가 깨질 수 있다.
    pub fn set_para_shape_id_native(
        &mut self,
        sec_idx: usize,
        para_idx: usize,
        para_shape_id: u16,
    ) -> Result<String, HwpError> {
        if sec_idx >= self.document.sections.len() {
            return Err(HwpError::RenderError(format!("구역 {} 범위 초과", sec_idx)));
        }
        if para_idx >= self.document.sections[sec_idx].paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 {} 범위 초과",
                para_idx
            )));
        }
        if para_shape_id as usize >= self.document.doc_info.para_shapes.len() {
            return Err(HwpError::RenderError(format!(
                "문단 모양 ID {} 범위 초과 (총 {}개)",
                para_shape_id,
                self.document.doc_info.para_shapes.len()
            )));
        }

        let styles = resolve_styles(&self.document.doc_info, self.dpi);
        let available_width = {
            let section = &self.document.sections[sec_idx];
            let page_def = &section.section_def.page_def;
            let column_def = DocumentCore::find_initial_column_def(&section.paragraphs);
            let layout = PageLayoutInfo::from_page_def(page_def, &column_def, self.dpi);
            let col_width = layout
                .column_areas
                .first()
                .map(|a| a.width)
                .unwrap_or(layout.body_area.width);
            let para_style = styles.para_styles.get(para_shape_id as usize);
            let margin_left = para_style.map(|s| s.margin_left).unwrap_or(0.0);
            let margin_right = para_style.map(|s| s.margin_right).unwrap_or(0.0);
            (col_width - margin_left - margin_right).max(1.0)
        };

        {
            let para = &mut self.document.sections[sec_idx].paragraphs[para_idx];
            para.para_shape_id = para_shape_id;
            reflow_line_segs(para, available_width, &styles, self.dpi);
        }

        self.document.sections[sec_idx].raw_stream = None;
        self.rebuild_section(sec_idx);
        self.event_log.push(DocumentEvent::ParaFormatChanged {
            section: sec_idx,
            para: para_idx,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 문단 서식 적용 (네이티브) — 셀 내 문단
    pub fn apply_para_format_in_cell_native(
        &mut self,
        sec_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        props_json: &str,
    ) -> Result<String, HwpError> {
        let mut mods = parse_para_shape_mods(props_json);

        // 탭 설정 변경 처리: TabDef 생성 → tab_def_id 세팅
        if json_has_tab_keys(props_json) {
            let para = self
                .get_cell_paragraph_ref(
                    sec_idx,
                    parent_para_idx,
                    control_idx,
                    cell_idx,
                    cell_para_idx,
                )
                .ok_or_else(|| HwpError::RenderError("셀 문단을 찾을 수 없음".to_string()))?;
            let base_tab_def_id = self
                .document
                .doc_info
                .para_shapes
                .get(para.para_shape_id as usize)
                .map(|ps| ps.tab_def_id)
                .unwrap_or(0);
            let new_td = build_tab_def_from_json(
                props_json,
                base_tab_def_id,
                &self.document.doc_info.tab_defs,
            );
            let new_tab_id = self.document.find_or_create_tab_def(new_td);
            mods.tab_def_id = Some(new_tab_id);
        }

        // 테두리/배경 변경 처리: BorderFill 생성 → border_fill_id 세팅
        if json_has_border_keys(props_json) {
            let bf_id = self.create_border_fill_from_json(props_json);
            mods.border_fill_id = Some(bf_id);
        }
        if let Some(arr) = parse_json_i16_array(props_json, "borderSpacing", 4) {
            mods.border_spacing = Some([arr[0], arr[1], arr[2], arr[3]]);
        }

        let new_id;
        {
            let para = self
                .get_cell_paragraph_ref(
                    sec_idx,
                    parent_para_idx,
                    control_idx,
                    cell_idx,
                    cell_para_idx,
                )
                .ok_or_else(|| HwpError::RenderError("셀 문단을 찾을 수 없음".to_string()))?;
            let base_id = para.para_shape_id;
            new_id = self.document.find_or_create_para_shape(base_id, &mods);

            let cell_para = self.get_cell_paragraph_mut(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )?;
            cell_para.para_shape_id = new_id;
        }

        // 줄간격 변경 시 셀 내 문단 LineSeg 재계산
        if mods.line_spacing.is_some() || mods.line_spacing_type.is_some() {
            let dpi = self.dpi;
            let styles = resolve_styles(&self.document.doc_info, dpi);
            let section = &self.document.sections[sec_idx];
            let page_def = &section.section_def.page_def;
            let column_def = DocumentCore::find_initial_column_def(&section.paragraphs);
            let layout = PageLayoutInfo::from_page_def(page_def, &column_def, dpi);
            let col_width = layout
                .column_areas
                .first()
                .map(|a| a.width)
                .unwrap_or(layout.body_area.width);
            let para_style = styles.para_styles.get(new_id as usize);
            let margin_left = para_style.map(|s| s.margin_left).unwrap_or(0.0);
            let margin_right = para_style.map(|s| s.margin_right).unwrap_or(0.0);
            let available_width = (col_width - margin_left - margin_right).max(1.0);
            let cell_para = self.get_cell_paragraph_mut(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )?;
            reflow_line_segs(cell_para, available_width, &styles, dpi);
        }

        // 표 dirty 마킹 — measure_section_incremental이 셀 높이를 재계산하도록
        {
            use crate::model::control::Control;
            if let Control::Table(ref mut t) =
                self.document.sections[sec_idx].paragraphs[parent_para_idx].controls[control_idx]
            {
                t.dirty = true;
            }
        }

        self.document.sections[sec_idx].raw_stream = None;
        self.rebuild_section(sec_idx);
        self.event_log.push(DocumentEvent::ParaFormatChanged {
            section: sec_idx,
            para: parent_para_idx,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 문단 서식 ID 직접 복원 (네이티브) — 셀 내 문단.
    pub fn set_cell_para_shape_id_native(
        &mut self,
        sec_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        para_shape_id: u16,
    ) -> Result<String, HwpError> {
        if para_shape_id as usize >= self.document.doc_info.para_shapes.len() {
            return Err(HwpError::RenderError(format!(
                "문단 모양 ID {} 범위 초과 (총 {}개)",
                para_shape_id,
                self.document.doc_info.para_shapes.len()
            )));
        }

        {
            let cell_para = self.get_cell_paragraph_mut(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )?;
            cell_para.para_shape_id = para_shape_id;
        }

        self.reflow_cell_paragraph(
            sec_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        );
        self.mark_cell_control_dirty(sec_idx, parent_para_idx, control_idx);
        self.document.sections[sec_idx].raw_stream = None;
        self.rebuild_section(sec_idx);
        self.event_log.push(DocumentEvent::ParaFormatChanged {
            section: sec_idx,
            para: parent_para_idx,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 문서 내 동일 style_id를 사용하는 기존 문단의 para_shape_id를 찾는다.
    fn find_reference_para_shape_for_style(&self, style_id: usize) -> Option<u16> {
        use crate::model::control::Control;

        for section in &self.document.sections {
            for para in &section.paragraphs {
                if para.style_id as usize == style_id {
                    return Some(para.para_shape_id);
                }
                for ctrl in &para.controls {
                    if let Control::Table(t) = ctrl {
                        for cell in &t.cells {
                            for cp in &cell.paragraphs {
                                if cp.style_id as usize == style_id {
                                    return Some(cp.para_shape_id);
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// 문서의 ParaShape 풀에서 동일 numbering_id·head_type이면서 target level인 것을 찾는다.
    fn find_para_shape_with_nid_and_level(
        &self,
        nid: u16,
        head_type: crate::model::style::HeadType,
        level: u8,
    ) -> Option<u16> {
        for (i, ps) in self.document.doc_info.para_shapes.iter().enumerate() {
            if ps.numbering_id == nid && ps.head_type == head_type && ps.para_level == level {
                return Some(i as u16);
            }
        }
        None
    }

    /// 스타일 이름에서 개요 수준을 추출한다. "개요 N" → Some(N-1)
    fn parse_outline_level_from_style(&self, style_id: usize) -> Option<u8> {
        let style = self.document.doc_info.styles.get(style_id)?;
        let name = style.local_name.trim();
        let rest = name.strip_prefix("개요")?.trim();
        let level_num = rest.parse::<u8>().ok()?;
        if level_num >= 1 && level_num <= 10 {
            Some(level_num - 1)
        } else {
            None
        }
    }

    /// 스타일에 맞는 ParaShape ID를 결정한다.
    ///
    /// current_psid: 현재 문단의 ParaShape ID (번호 문맥 보존용)
    ///
    /// 번호가 있는 문단의 스타일을 변경할 때 numbering_id를 보존하여
    /// 후속 문단의 번호 연속성을 유지한다.
    fn resolve_style_para_shape_id(&mut self, style_id: usize, current_psid: u16) -> u16 {
        use crate::model::style::HeadType;

        let current_ps = self
            .document
            .doc_info
            .para_shapes
            .get(current_psid as usize)
            .cloned();
        let current_head = current_ps
            .as_ref()
            .map(|ps| ps.head_type)
            .unwrap_or(HeadType::None);
        let current_nid = current_ps.as_ref().map(|ps| ps.numbering_id).unwrap_or(0);

        // ── 현재 문단이 번호/개요를 가지고 있는 경우 ──
        // numbering_id와 head_type을 보존하고 para_level만 변경
        if current_head != HeadType::None {
            // 대상 스타일의 개요 수준 결정
            let target_level = self.parse_outline_level_from_style(style_id).or_else(|| {
                // 스타일 이름에서 못 찾으면 참조 문단에서 추출
                self.find_reference_para_shape_for_style(style_id)
                    .and_then(|psid| self.document.doc_info.para_shapes.get(psid as usize))
                    .filter(|ps| ps.head_type != HeadType::None)
                    .map(|ps| ps.para_level)
            });

            if let Some(level) = target_level {
                // 같은 numbering_id·head_type에서 target level인 ParaShape 검색
                if let Some(found) =
                    self.find_para_shape_with_nid_and_level(current_nid, current_head, level)
                {
                    return found;
                }

                // 없으면 현재 ParaShape 기반으로 level + 여백 변경하여 생성
                let current_level = current_ps.as_ref().map(|ps| ps.para_level).unwrap_or(0);
                let current_margin = current_ps.as_ref().map(|ps| ps.margin_left).unwrap_or(0);
                // 수준별 여백 증감: 수준 1단계당 2000 HWPUNIT
                let margin_delta = (level as i32 - current_level as i32) * 2000;
                let new_margin = (current_margin + margin_delta).max(0);
                let mods = crate::model::style::ParaShapeMods {
                    para_level: Some(level),
                    margin_left: Some(new_margin),
                    ..Default::default()
                };
                return self.document.find_or_create_para_shape(current_psid, &mods);
            }
        }

        // ── 현재 문단에 번호가 없는 경우 (바탕글 등) ──
        // 일반 스타일은 기존 문단의 실효 ParaShape가 아니라 스타일 정의값을 따른다.
        // 참조 문단을 우선하면 직접 서식이 섞인 문단 값이 스타일 적용값으로 번질 수 있다.
        let style = match self.document.doc_info.styles.get(style_id) {
            Some(s) => s.clone(),
            None => return 0,
        };
        let base_psid = style.para_shape_id;

        // 스타일 이름에서 "개요 N" 패턴 감지
        if let Some(level) = self.parse_outline_level_from_style(style_id) {
            // Outline 문단의 numbering_id는 0 (렌더링 시 구역의 outline_numbering_id로 해석)
            let mods = crate::model::style::ParaShapeMods {
                head_type: Some(HeadType::Outline),
                para_level: Some(level),
                numbering_id: Some(0),
                ..Default::default()
            };
            return self.document.find_or_create_para_shape(base_psid, &mods);
        }

        // 일반 스타일 → 기본 ParaShape 사용
        base_psid
    }

    /// 본문 문단의 LineSeg를 현재 CharShape/ParaShape 기준으로 다시 계산한다.
    pub(crate) fn reflow_body_paragraph(&mut self, sec_idx: usize, para_idx: usize) {
        let para_shape_id = match self
            .document
            .sections
            .get(sec_idx)
            .and_then(|s| s.paragraphs.get(para_idx))
        {
            Some(para) => para.para_shape_id,
            None => return,
        };
        let styles = resolve_styles(&self.document.doc_info, self.dpi);
        let available_width =
            body_available_width_for_para_shape(self, sec_idx, para_shape_id, &styles);
        if let Some(para) = self
            .document
            .sections
            .get_mut(sec_idx)
            .and_then(|s| s.paragraphs.get_mut(para_idx))
        {
            para.line_segs.clear();
            reflow_line_segs(para, available_width, &styles, self.dpi);
        }
    }

    /// 스타일 적용 (네이티브) — 본문 문단
    pub fn apply_style_native(
        &mut self,
        sec_idx: usize,
        para_idx: usize,
        style_id: usize,
    ) -> Result<String, HwpError> {
        let style = self
            .document
            .doc_info
            .styles
            .get(style_id)
            .cloned()
            .ok_or_else(|| HwpError::RenderError(format!("스타일 {} 범위 초과", style_id)))?;
        let new_char_shape_id = style.char_shape_id as u32;

        // 현재 문단의 기존 스타일/문단 모양을 먼저 읽어서 직접 서식 여부를 판단한다.
        let (current_style_id, current_psid) = self
            .document
            .sections
            .get(sec_idx)
            .and_then(|s| s.paragraphs.get(para_idx))
            .map(|p| (p.style_id, p.para_shape_id))
            .ok_or_else(|| {
                HwpError::RenderError(format!("문단 {}/{} 범위 초과", sec_idx, para_idx))
            })?;
        let old_style = self
            .document
            .doc_info
            .styles
            .get(current_style_id as usize)
            .cloned();

        if style.style_type == 1 {
            let text_len = {
                let para = self
                    .document
                    .sections
                    .get_mut(sec_idx)
                    .and_then(|s| s.paragraphs.get_mut(para_idx))
                    .ok_or_else(|| {
                        HwpError::RenderError(format!("문단 {}/{} 범위 초과", sec_idx, para_idx))
                    })?;
                para.apply_char_shape_to_entire_text(new_char_shape_id);
                para.text.chars().count()
            };

            self.reflow_body_paragraph(sec_idx, para_idx);
            self.document.sections[sec_idx].raw_stream = None;
            self.rebuild_section(sec_idx);
            self.event_log.push(DocumentEvent::CharFormatChanged {
                section: sec_idx,
                para: para_idx,
                start: 0,
                end: text_len,
            });
            return Ok("{\"ok\":true}".to_string());
        }

        let new_para_shape_id = match old_style.as_ref() {
            Some(old) if current_psid != old.para_shape_id => current_psid,
            _ => self.resolve_style_para_shape_id(style_id, current_psid),
        };

        let para = self
            .document
            .sections
            .get_mut(sec_idx)
            .and_then(|s| s.paragraphs.get_mut(para_idx))
            .ok_or_else(|| {
                HwpError::RenderError(format!("문단 {}/{} 범위 초과", sec_idx, para_idx))
            })?;

        para.style_id = style_id as u8;
        para.para_shape_id = new_para_shape_id;
        if let Some(old) = old_style {
            para.replace_style_char_shape_preserving_overrides(
                old.char_shape_id as u32,
                new_char_shape_id,
            );
        } else {
            para.set_single_char_shape(new_char_shape_id);
        }

        self.reflow_body_paragraph(sec_idx, para_idx);
        self.document.sections[sec_idx].raw_stream = None;
        self.rebuild_section(sec_idx);
        self.event_log.push(DocumentEvent::ParaFormatChanged {
            section: sec_idx,
            para: para_idx,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 스타일 적용 (네이티브) — 셀 내 문단
    pub fn apply_cell_style_native(
        &mut self,
        sec_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        style_id: usize,
    ) -> Result<String, HwpError> {
        let style = self
            .document
            .doc_info
            .styles
            .get(style_id)
            .cloned()
            .ok_or_else(|| HwpError::RenderError(format!("스타일 {} 범위 초과", style_id)))?;
        let new_char_shape_id = style.char_shape_id as u32;

        // 현재 셀 문단의 기존 스타일/문단 모양을 먼저 읽어서 직접 서식 여부를 판단한다.
        let (current_style_id, current_psid) = self
            .get_cell_paragraph_ref(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )
            .map(|p| (p.style_id, p.para_shape_id))
            .ok_or_else(|| HwpError::RenderError("셀 문단을 찾을 수 없음".to_string()))?;
        let old_style = self
            .document
            .doc_info
            .styles
            .get(current_style_id as usize)
            .cloned();

        if style.style_type == 1 {
            let text_len = {
                let cell_para = self.get_cell_paragraph_mut(
                    sec_idx,
                    parent_para_idx,
                    control_idx,
                    cell_idx,
                    cell_para_idx,
                )?;
                cell_para.apply_char_shape_to_entire_text(new_char_shape_id);
                cell_para.text.chars().count()
            };

            self.reflow_cell_paragraph(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            );
            self.mark_cell_control_dirty(sec_idx, parent_para_idx, control_idx);
            self.document.sections[sec_idx].raw_stream = None;
            self.rebuild_section(sec_idx);
            self.event_log.push(DocumentEvent::CharFormatChanged {
                section: sec_idx,
                para: parent_para_idx,
                start: 0,
                end: text_len,
            });
            return Ok("{\"ok\":true}".to_string());
        }

        let new_para_shape_id = match old_style.as_ref() {
            Some(old) if current_psid != old.para_shape_id => current_psid,
            _ => self.resolve_style_para_shape_id(style_id, current_psid),
        };

        {
            let cell_para = self.get_cell_paragraph_mut(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )?;
            cell_para.style_id = style_id as u8;
            cell_para.para_shape_id = new_para_shape_id;
            if let Some(old) = old_style {
                cell_para.replace_style_char_shape_preserving_overrides(
                    old.char_shape_id as u32,
                    new_char_shape_id,
                );
            } else {
                cell_para.set_single_char_shape(new_char_shape_id);
            }
        }

        self.reflow_cell_paragraph(
            sec_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        );
        self.mark_cell_control_dirty(sec_idx, parent_para_idx, control_idx);
        self.document.sections[sec_idx].raw_stream = None;
        self.rebuild_section(sec_idx);
        self.event_log.push(DocumentEvent::ParaFormatChanged {
            section: sec_idx,
            para: parent_para_idx,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 본문 문단에 글자 서식 적용 헬퍼
    pub(crate) fn apply_char_mods_to_paragraph(
        &mut self,
        sec_idx: usize,
        para_idx: usize,
        start_offset: usize,
        end_offset: usize,
        mods: &crate::model::style::CharShapeMods,
    ) {
        let base_id = self.document.sections[sec_idx].paragraphs[para_idx]
            .char_shape_id_at(start_offset)
            .unwrap_or(0);
        let new_id = self.document.find_or_create_char_shape(base_id, mods);
        self.document.sections[sec_idx].paragraphs[para_idx].apply_char_shape_range(
            start_offset,
            end_offset,
            new_id,
        );
    }

    /// 문단 번호 시작 방식을 설정한다.
    /// mode: 0 = 앞 번호 목록에 이어 (기본), 1 = 이전 번호 목록에 이어, 2 = 새 번호 목록 시작
    /// start_num: mode=2일 때 시작 번호
    pub fn set_numbering_restart_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        mode: u8,
        start_num: u32,
    ) -> Result<String, crate::error::HwpError> {
        use crate::model::paragraph::NumberingRestart;

        if section_idx >= self.document.sections.len() {
            return Err(crate::error::HwpError::RenderError(
                "구역 범위 초과".to_string(),
            ));
        }
        if para_idx >= self.document.sections[section_idx].paragraphs.len() {
            return Err(crate::error::HwpError::RenderError(
                "문단 범위 초과".to_string(),
            ));
        }

        let restart = match mode {
            0 => None,
            1 => Some(NumberingRestart::ContinuePrevious),
            2 => Some(NumberingRestart::NewStart(start_num)),
            _ => None,
        };

        self.document.sections[section_idx].paragraphs[para_idx].numbering_restart = restart;
        self.document.sections[section_idx].raw_stream = None;

        self.recompose_section(section_idx);
        self.paginate_if_needed();

        Ok(crate::document_core::helpers::json_ok())
    }

    /// 감추기(PageHide) 컨트롤을 현재 문단에 삽입 또는 갱신한다.
    /// flags: { hideHeader, hideFooter, hideMasterPage, hideBorder, hideFill, hidePageNum }
    pub fn set_page_hide_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        hide_header: bool,
        hide_footer: bool,
        hide_master_page: bool,
        hide_border: bool,
        hide_fill: bool,
        hide_page_num: bool,
    ) -> Result<String, crate::error::HwpError> {
        use crate::model::control::{Control, PageHide};

        if section_idx >= self.document.sections.len() {
            return Err(crate::error::HwpError::RenderError(
                "구역 범위 초과".to_string(),
            ));
        }
        if para_idx >= self.document.sections[section_idx].paragraphs.len() {
            return Err(crate::error::HwpError::RenderError(
                "문단 범위 초과".to_string(),
            ));
        }

        let all_false = !hide_header
            && !hide_footer
            && !hide_master_page
            && !hide_border
            && !hide_fill
            && !hide_page_num;

        let para = &mut self.document.sections[section_idx].paragraphs[para_idx];

        // 기존 PageHide 컨트롤 찾기
        let existing_idx = para
            .controls
            .iter()
            .position(|c| matches!(c, Control::PageHide(_)));

        if all_false {
            // 모두 false → 기존 PageHide 제거
            if let Some(idx) = existing_idx {
                para.controls.remove(idx);
                if idx < para.ctrl_data_records.len() {
                    para.ctrl_data_records.remove(idx);
                }
            }
        } else {
            let ph = PageHide {
                hide_header,
                hide_footer,
                hide_master_page,
                hide_border,
                hide_fill,
                hide_page_num,
            };
            if let Some(idx) = existing_idx {
                // 기존 컨트롤 갱신
                para.controls[idx] = Control::PageHide(ph);
            } else {
                // 새 컨트롤 삽입 (문단 맨 앞)
                para.controls.insert(0, Control::PageHide(ph));
                para.ctrl_data_records.insert(0, None);
            }
        }

        self.document.sections[section_idx].raw_stream = None;
        self.recompose_section(section_idx);
        self.paginate_if_needed();

        Ok(crate::document_core::helpers::json_ok())
    }

    /// 현재 문단의 PageHide 상태를 조회한다.
    pub fn get_page_hide_native(
        &self,
        section_idx: usize,
        para_idx: usize,
    ) -> Result<String, crate::error::HwpError> {
        use crate::model::control::Control;

        let section = self
            .document
            .sections
            .get(section_idx)
            .ok_or_else(|| crate::error::HwpError::RenderError("구역 범위 초과".to_string()))?;
        let para = section
            .paragraphs
            .get(para_idx)
            .ok_or_else(|| crate::error::HwpError::RenderError("문단 범위 초과".to_string()))?;

        for ctrl in &para.controls {
            if let Control::PageHide(ph) = ctrl {
                return Ok(format!(
                    "{{\"ok\":true,\"exists\":true,\"hideHeader\":{},\"hideFooter\":{},\"hideMasterPage\":{},\"hideBorder\":{},\"hideFill\":{},\"hidePageNum\":{}}}",
                    ph.hide_header, ph.hide_footer, ph.hide_master_page,
                    ph.hide_border, ph.hide_fill, ph.hide_page_num
                ));
            }
        }
        Ok("{\"ok\":true,\"exists\":false}".to_string())
    }

    // ─── 중첩 표 경로 기반 서식 API (cellPath 계약) ─────────────────────────
    //
    // 경로 규약은 hitTest cellPath 와 같다 — `[(control_idx, cell_idx, cell_para_idx), …]`,
    // 마지막 항목이 대상 표·셀·문단. 깊이 1 은 기존 flat 네이티브에 위임해 편집 계약을 하나로 둔다
    // (`insert_text_in_cell_by_path` 와 같은 원칙). rhwp-studio 의 F5 셀 선택 서식(글자·문단·스타일)이
    // 중첩 표에서도 동작하게 하는 것이 목적이다 — 종전에는 `applyCharFormatInCell(Ex)` 에
    // cellPath 인자가 없어 편집기가 중첩 표 셀 선택을 "미지원" 으로 돌려보냈다.

    /// 경로 기반 서식 변경의 뒤처리 — 대상(중첩) 표와 최외곽 표를 dirty 로 마킹해 셀 높이를
    /// 다시 재고, 구역을 재구성한다. 깊이 2 이상 전용(깊이 1 은 flat 네이티브가 처리).
    fn finish_cell_format_by_path(
        &mut self,
        sec_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
    ) {
        if let Ok(t) = self.get_table_mut_by_path(sec_idx, parent_para_idx, path) {
            t.dirty = true;
        }
        self.mark_cell_control_dirty(sec_idx, parent_para_idx, path[0].0);
        self.document.sections[sec_idx].raw_stream = None;
        self.rebuild_section(sec_idx);
    }

    /// 글자 서식 적용 (네이티브) — 경로 기반 (중첩 표 셀 문단).
    /// 빈 문단이면 `apply_char_format_in_cell_native` 와 같이 유일한 CharShapeRef 를 통째로 바꾼다.
    pub fn apply_char_format_in_cell_by_path_native(
        &mut self,
        sec_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        start_offset: usize,
        end_offset: usize,
        props_json: &str,
    ) -> Result<String, HwpError> {
        let Some(&(control_idx, cell_idx, cell_para_idx)) = path.last() else {
            return Err(HwpError::RenderError("경로가 비어있습니다".to_string()));
        };
        if path.len() == 1 {
            return self.apply_char_format_in_cell_native(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
                start_offset,
                end_offset,
                props_json,
            );
        }

        let mut mods = parse_char_shape_mods(props_json);
        if json_has_border_keys(props_json) {
            let bf_id = self.create_border_fill_from_json(props_json);
            mods.border_fill_id = Some(bf_id);
        }

        let base_id = self
            .resolve_paragraph_by_path(sec_idx, parent_para_idx, path)?
            .char_shape_id_at(start_offset)
            .unwrap_or(0);
        let new_id = self.document.find_or_create_char_shape(base_id, &mods);
        {
            let cell_para = self.get_cell_paragraph_mut_by_path(sec_idx, parent_para_idx, path)?;
            if cell_para.text.is_empty() {
                cell_para.set_single_char_shape(new_id);
            } else {
                cell_para.apply_char_shape_range(start_offset, end_offset, new_id);
            }
        }

        // 글자 폭·높이가 바뀌면 그 셀 폭으로 LineSeg 재계산 (깊이 1 의 set_char_shape_id 경로와 같은 폭 계산)
        if char_shape_mods_affect_text_flow(&mods) {
            self.reflow_cell_paragraph_by_path(
                sec_idx,
                parent_para_idx,
                path,
                cell_idx,
                cell_para_idx,
            );
        }
        self.finish_cell_format_by_path(sec_idx, parent_para_idx, path);
        self.event_log.push(DocumentEvent::CharFormatChanged {
            section: sec_idx,
            para: parent_para_idx,
            start: start_offset,
            end: end_offset,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 글자 모양 ID 를 직접 되돌린다 (네이티브) — 경로 기반 (중첩 표 셀 문단), 편집기 되돌리기/다시실행용.
    /// 깊이 1 은 `set_char_shape_id_in_cell_native` 에 위임한다. 빈 문단이면 유일한 CharShapeRef 를 통째로 바꾼다.
    pub fn set_char_shape_id_in_cell_by_path_native(
        &mut self,
        sec_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        start_offset: usize,
        end_offset: usize,
        char_shape_id: u32,
    ) -> Result<String, HwpError> {
        let Some(&(control_idx, cell_idx, cell_para_idx)) = path.last() else {
            return Err(HwpError::RenderError("경로가 비어있습니다".to_string()));
        };
        if path.len() == 1 {
            return self.set_char_shape_id_in_cell_native(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
                start_offset,
                end_offset,
                char_shape_id,
            );
        }
        if char_shape_id as usize >= self.document.doc_info.char_shapes.len() {
            return Err(HwpError::RenderError(format!(
                "글자 모양 ID {} 범위 초과 (총 {}개)",
                char_shape_id,
                self.document.doc_info.char_shapes.len()
            )));
        }
        {
            let cell_para = self.get_cell_paragraph_mut_by_path(sec_idx, parent_para_idx, path)?;
            if cell_para.text.is_empty() {
                cell_para.set_single_char_shape(char_shape_id);
            } else {
                cell_para.apply_char_shape_range(start_offset, end_offset, char_shape_id);
            }
        }
        self.reflow_cell_paragraph_by_path(sec_idx, parent_para_idx, path, cell_idx, cell_para_idx);
        self.finish_cell_format_by_path(sec_idx, parent_para_idx, path);
        self.event_log.push(DocumentEvent::CharFormatChanged {
            section: sec_idx,
            para: parent_para_idx,
            start: start_offset,
            end: end_offset,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 문단 서식 적용 (네이티브) — 경로 기반 (중첩 표 셀 문단).
    pub fn apply_para_format_in_cell_by_path_native(
        &mut self,
        sec_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        props_json: &str,
    ) -> Result<String, HwpError> {
        let Some(&(control_idx, cell_idx, cell_para_idx)) = path.last() else {
            return Err(HwpError::RenderError("경로가 비어있습니다".to_string()));
        };
        if path.len() == 1 {
            return self.apply_para_format_in_cell_native(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
                props_json,
            );
        }

        let mut mods = parse_para_shape_mods(props_json);
        let base_id = self
            .resolve_paragraph_by_path(sec_idx, parent_para_idx, path)?
            .para_shape_id;

        if json_has_tab_keys(props_json) {
            let base_tab_def_id = self
                .document
                .doc_info
                .para_shapes
                .get(base_id as usize)
                .map(|ps| ps.tab_def_id)
                .unwrap_or(0);
            let new_td = build_tab_def_from_json(
                props_json,
                base_tab_def_id,
                &self.document.doc_info.tab_defs,
            );
            let new_tab_id = self.document.find_or_create_tab_def(new_td);
            mods.tab_def_id = Some(new_tab_id);
        }
        if json_has_border_keys(props_json) {
            let bf_id = self.create_border_fill_from_json(props_json);
            mods.border_fill_id = Some(bf_id);
        }
        if let Some(arr) = parse_json_i16_array(props_json, "borderSpacing", 4) {
            mods.border_spacing = Some([arr[0], arr[1], arr[2], arr[3]]);
        }

        let new_id = self.document.find_or_create_para_shape(base_id, &mods);
        self.get_cell_paragraph_mut_by_path(sec_idx, parent_para_idx, path)?
            .para_shape_id = new_id;

        if mods.line_spacing.is_some() || mods.line_spacing_type.is_some() {
            self.reflow_cell_paragraph_by_path(
                sec_idx,
                parent_para_idx,
                path,
                cell_idx,
                cell_para_idx,
            );
        }
        self.finish_cell_format_by_path(sec_idx, parent_para_idx, path);
        self.event_log.push(DocumentEvent::ParaFormatChanged {
            section: sec_idx,
            para: parent_para_idx,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 문단 서식 ID 직접 복원 (네이티브) — 경로 기반. 편집기 `ApplyParaFormatCommand` 의 되돌리기용.
    pub fn set_para_shape_id_by_path_native(
        &mut self,
        sec_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        para_shape_id: u16,
    ) -> Result<String, HwpError> {
        let Some(&(control_idx, cell_idx, cell_para_idx)) = path.last() else {
            return Err(HwpError::RenderError("경로가 비어있습니다".to_string()));
        };
        if path.len() == 1 {
            return self.set_cell_para_shape_id_native(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
                para_shape_id,
            );
        }
        if para_shape_id as usize >= self.document.doc_info.para_shapes.len() {
            return Err(HwpError::RenderError(format!(
                "문단 모양 ID {} 범위 초과 (총 {}개)",
                para_shape_id,
                self.document.doc_info.para_shapes.len()
            )));
        }
        self.get_cell_paragraph_mut_by_path(sec_idx, parent_para_idx, path)?
            .para_shape_id = para_shape_id;
        self.reflow_cell_paragraph_by_path(sec_idx, parent_para_idx, path, cell_idx, cell_para_idx);
        self.finish_cell_format_by_path(sec_idx, parent_para_idx, path);
        self.event_log.push(DocumentEvent::ParaFormatChanged {
            section: sec_idx,
            para: parent_para_idx,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 스타일 적용 (네이티브) — 경로 기반 (중첩 표 셀 문단). `apply_cell_style_native` 와 같은 규칙.
    pub fn apply_style_by_path_native(
        &mut self,
        sec_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        style_id: usize,
    ) -> Result<String, HwpError> {
        let Some(&(control_idx, cell_idx, cell_para_idx)) = path.last() else {
            return Err(HwpError::RenderError("경로가 비어있습니다".to_string()));
        };
        if path.len() == 1 {
            return self.apply_cell_style_native(
                sec_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
                style_id,
            );
        }
        let style = self
            .document
            .doc_info
            .styles
            .get(style_id)
            .cloned()
            .ok_or_else(|| HwpError::RenderError(format!("스타일 {} 범위 초과", style_id)))?;
        let new_char_shape_id = style.char_shape_id as u32;

        let (current_style_id, current_psid) = {
            let p = self.resolve_paragraph_by_path(sec_idx, parent_para_idx, path)?;
            (p.style_id, p.para_shape_id)
        };
        let old_style = self
            .document
            .doc_info
            .styles
            .get(current_style_id as usize)
            .cloned();

        if style.style_type == 1 {
            let text_len = {
                let cell_para =
                    self.get_cell_paragraph_mut_by_path(sec_idx, parent_para_idx, path)?;
                cell_para.apply_char_shape_to_entire_text(new_char_shape_id);
                cell_para.text.chars().count()
            };
            self.reflow_cell_paragraph_by_path(
                sec_idx,
                parent_para_idx,
                path,
                cell_idx,
                cell_para_idx,
            );
            self.finish_cell_format_by_path(sec_idx, parent_para_idx, path);
            self.event_log.push(DocumentEvent::CharFormatChanged {
                section: sec_idx,
                para: parent_para_idx,
                start: 0,
                end: text_len,
            });
            return Ok("{\"ok\":true}".to_string());
        }

        let new_para_shape_id = match old_style.as_ref() {
            Some(old) if current_psid != old.para_shape_id => current_psid,
            _ => self.resolve_style_para_shape_id(style_id, current_psid),
        };
        {
            let cell_para = self.get_cell_paragraph_mut_by_path(sec_idx, parent_para_idx, path)?;
            cell_para.style_id = style_id as u8;
            cell_para.para_shape_id = new_para_shape_id;
            if let Some(old) = old_style {
                cell_para.replace_style_char_shape_preserving_overrides(
                    old.char_shape_id as u32,
                    new_char_shape_id,
                );
            } else {
                cell_para.set_single_char_shape(new_char_shape_id);
            }
        }
        self.reflow_cell_paragraph_by_path(sec_idx, parent_para_idx, path, cell_idx, cell_para_idx);
        self.finish_cell_format_by_path(sec_idx, parent_para_idx, path);
        self.event_log.push(DocumentEvent::ParaFormatChanged {
            section: sec_idx,
            para: parent_para_idx,
        });
        Ok("{\"ok\":true}".to_string())
    }

    /// 글자 속성 조회 (네이티브) — 경로 기반. 빈 경로는 본문 문단 (`get_para_properties_by_path_native` 와 같은 계약).
    pub fn get_char_properties_by_path_native(
        &self,
        sec_idx: usize,
        parent_para_idx: usize,
        cell_path: &[(usize, usize, usize)],
        char_offset: usize,
    ) -> Result<String, HwpError> {
        let para = self.resolve_control_para(sec_idx, parent_para_idx, cell_path)?;
        Ok(self.build_char_properties_json(para, char_offset))
    }

    /// 문단 스타일 조회 (네이티브) — 경로 기반. 반환 `{"id":N,"name":"…"}`, 빈 경로는 본문 문단.
    pub fn get_style_by_path_native(
        &self,
        sec_idx: usize,
        parent_para_idx: usize,
        cell_path: &[(usize, usize, usize)],
    ) -> Result<String, HwpError> {
        let style_id = self
            .resolve_control_para(sec_idx, parent_para_idx, cell_path)?
            .style_id as usize;
        let name = self
            .document
            .doc_info
            .styles
            .get(style_id)
            .map(|s| s.local_name.as_str())
            .unwrap_or("");
        Ok(format!(
            "{{\"id\":{},\"name\":\"{}\"}}",
            style_id,
            json_escape(name)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::char_shape_mods_affect_text_flow;
    use crate::model::style::CharShapeMods;

    #[test]
    fn char_ratio_and_spacing_changes_require_text_reflow() {
        let mods = CharShapeMods {
            ratios: Some([99; 7]),
            ..Default::default()
        };
        assert!(char_shape_mods_affect_text_flow(&mods));

        let mods = CharShapeMods {
            spacings: Some([-1; 7]),
            ..Default::default()
        };
        assert!(char_shape_mods_affect_text_flow(&mods));
    }

    #[test]
    fn paint_only_char_shape_changes_do_not_require_text_reflow() {
        let mods = CharShapeMods {
            underline: Some(true),
            ..Default::default()
        };
        assert!(!char_shape_mods_affect_text_flow(&mods));
    }

    /// 빈 셀(빈 문단)에 글자 서식을 적용하면 문단의 유일한 CharShapeRef 가 새 ID 로 바뀐다.
    /// 한컴은 빈 셀을 블록 선택해 글꼴·크기를 바꾸면 "다음에 입력할 글자"가 새 모양으로 나온다 —
    /// 종전에는 글자 범위가 없어 apply_char_shape_range 가 아무것도 안 했다.
    #[test]
    fn apply_char_format_in_cell_updates_empty_paragraph_char_shape() {
        use crate::document_core::helpers::json_u32;
        use crate::document_core::DocumentCore;

        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        let res = core.create_table_native(0, 0, 0, 1, 2).unwrap();
        let para_idx = json_u32(&res, "paraIdx").unwrap() as usize;
        let ctrl_idx = json_u32(&res, "controlIdx").unwrap() as usize;

        let before = core
            .get_cell_paragraph_ref(0, para_idx, ctrl_idx, 0, 0)
            .unwrap()
            .char_shape_id_at(0)
            .unwrap_or(0);
        core.apply_char_format_in_cell_native(
            0,
            para_idx,
            ctrl_idx,
            0,
            0,
            0,
            0,
            r#"{"bold":true,"fontSize":2000}"#,
        )
        .unwrap();

        let para = core
            .get_cell_paragraph_ref(0, para_idx, ctrl_idx, 0, 0)
            .unwrap();
        assert!(para.text.is_empty(), "표적은 빈 문단이어야 한다");
        assert_eq!(para.char_shapes.len(), 1, "빈 문단의 CharShapeRef 는 하나");
        let after = para.char_shape_id_at(0).unwrap();
        assert_ne!(before, after, "빈 문단의 글자 모양 ID 가 바뀌어야 한다");

        let json: String = core
            .get_cell_char_properties_at_native(0, para_idx, ctrl_idx, 0, 0, 0)
            .unwrap()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        assert!(json.contains(r#""bold":true"#), "{json}");
        assert!(json.contains(r#""fontSize":2000"#), "{json}");

        // 이웃 빈 셀은 그대로
        let other = core
            .get_cell_paragraph_ref(0, para_idx, ctrl_idx, 1, 0)
            .unwrap()
            .char_shape_id_at(0)
            .unwrap_or(0);
        assert_eq!(other, before, "적용하지 않은 셀의 글자 모양은 불변");
    }

    // ─── 경로 기반 서식 API (중첩 표) ─────────────────────────────────

    /// 1×2 표 안 셀 0 문단 0 에 같은 모양의 1×2 표를 중첩시킨 문서. 반환: (parent_para, 깊이2 경로 셀0·문단0)
    fn nested_table_fixture() -> (crate::document_core::DocumentCore, usize, Vec<(usize, usize, usize)>) {
        use crate::document_core::helpers::json_u32;
        use crate::document_core::DocumentCore;

        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        let res = core.create_table_native(0, 0, 0, 1, 2).unwrap();
        let para_idx = json_u32(&res, "paraIdx").unwrap() as usize;
        let ctrl_idx = json_u32(&res, "controlIdx").unwrap() as usize;

        let inner = match &core.document.sections[0].paragraphs[para_idx].controls[ctrl_idx] {
            crate::model::control::Control::Table(t) => (**t).clone(),
            _ => panic!("표가 아니다"),
        };
        let host = core.get_cell_paragraph_mut(0, para_idx, ctrl_idx, 0, 0).unwrap();
        host.controls.push(crate::model::control::Control::Table(Box::new(inner)));
        let inner_ctrl = host.controls.len() - 1;
        (core, para_idx, vec![(ctrl_idx, 0, 0), (inner_ctrl, 0, 0)])
    }

    fn compact(json: &str) -> String {
        json.chars().filter(|c| !c.is_whitespace()).collect()
    }

    /// 깊이 2 경로로 글자 서식을 적용하면 중첩 표의 그 셀만 바뀌고, 호스트 셀·이웃 셀은 그대로다.
    /// 빈 문단이면 유일한 CharShapeRef 를 통째로 바꾼다(빈 셀 서식, 깊이 1 과 같은 계약).
    #[test]
    fn apply_char_format_by_path_targets_nested_cell_only() {
        let (mut core, ppi, path) = nested_table_fixture();
        let before = core
            .resolve_paragraph_by_path(0, ppi, &path)
            .unwrap()
            .char_shape_id_at(0)
            .unwrap_or(0);
        let host_before = core
            .get_cell_paragraph_ref(0, ppi, path[0].0, 0, 0)
            .unwrap()
            .char_shape_id_at(0)
            .unwrap_or(0);

        core.apply_char_format_in_cell_by_path_native(
            0,
            ppi,
            &path,
            0,
            0,
            r#"{"bold":true,"fontSize":2000}"#,
        )
        .unwrap();

        let para = core.resolve_paragraph_by_path(0, ppi, &path).unwrap();
        assert!(para.text.is_empty());
        assert_eq!(para.char_shapes.len(), 1, "빈 문단의 CharShapeRef 는 하나");
        assert_ne!(para.char_shape_id_at(0).unwrap(), before);

        let json = compact(&core.get_char_properties_by_path_native(0, ppi, &path, 0).unwrap());
        assert!(json.contains(r#""bold":true"#), "{json}");
        assert!(json.contains(r#""fontSize":2000"#), "{json}");

        // 중첩 표 이웃 셀 1 과 호스트 셀 0 은 불변
        let sibling = [path[0], (path[1].0, 1, 0)];
        let sib_id = core
            .resolve_paragraph_by_path(0, ppi, &sibling)
            .unwrap()
            .char_shape_id_at(0)
            .unwrap_or(0);
        assert_eq!(sib_id, before, "중첩 표 이웃 셀은 불변");
        let host_after = core
            .get_cell_paragraph_ref(0, ppi, path[0].0, 0, 0)
            .unwrap()
            .char_shape_id_at(0)
            .unwrap_or(0);
        assert_eq!(host_after, host_before, "호스트(바깥) 셀은 불변");
    }

    /// 깊이 1 경로는 flat 네이티브에 위임한다 — 결과가 flat 호출과 같다.
    #[test]
    fn apply_char_format_by_path_depth1_matches_flat() {
        let (mut core, ppi, path) = nested_table_fixture();
        let outer = path[0].0;
        core.apply_char_format_in_cell_by_path_native(0, ppi, &[(outer, 1, 0)], 0, 0, r#"{"italic":true}"#)
            .unwrap();
        let by_path = compact(&core.get_char_properties_by_path_native(0, ppi, &[(outer, 1, 0)], 0).unwrap());
        let flat = compact(&core.get_cell_char_properties_at_native(0, ppi, outer, 1, 0, 0).unwrap());
        assert_eq!(by_path, flat);
        assert!(flat.contains(r#""italic":true"#), "{flat}");
    }

    /// 되돌리기: 경로로 글자 모양 ID 를 직접 되돌리면 적용 전 ID 로 돌아가고(서식도 원상),
    /// 중첩 표 이웃 셀·호스트 셀은 불변. 편집기 `ApplyCharFormatCommand` 의 중첩 셀 undo 가 이 API 를 쓴다.
    #[test]
    fn set_char_shape_id_by_path_restores_nested_cell() {
        let (mut core, ppi, path) = nested_table_fixture();
        let before = core
            .resolve_paragraph_by_path(0, ppi, &path)
            .unwrap()
            .char_shape_id_at(0)
            .unwrap_or(0);
        let sibling = [path[0], (path[1].0, 1, 0)];
        let host_before = core
            .get_cell_paragraph_ref(0, ppi, path[0].0, 0, 0)
            .unwrap()
            .char_shape_id_at(0)
            .unwrap_or(0);

        core.apply_char_format_in_cell_by_path_native(0, ppi, &path, 0, 0, r#"{"bold":true}"#)
            .unwrap();
        let applied = core.resolve_paragraph_by_path(0, ppi, &path).unwrap().char_shape_id_at(0).unwrap();
        assert_ne!(applied, before);

        core.set_char_shape_id_in_cell_by_path_native(0, ppi, &path, 0, 0, before).unwrap();
        let para = core.resolve_paragraph_by_path(0, ppi, &path).unwrap();
        assert_eq!(para.char_shapes.len(), 1, "빈 문단의 CharShapeRef 는 하나");
        assert_eq!(para.char_shape_id_at(0).unwrap(), before, "되돌린 ID");
        let json = compact(&core.get_char_properties_by_path_native(0, ppi, &path, 0).unwrap());
        assert!(!json.contains(r#""bold":true"#), "{json}");

        // 다시실행: 적용 후 ID 로 되돌리면 굵게가 돌아온다
        core.set_char_shape_id_in_cell_by_path_native(0, ppi, &path, 0, 0, applied).unwrap();
        let json = compact(&core.get_char_properties_by_path_native(0, ppi, &path, 0).unwrap());
        assert!(json.contains(r#""bold":true"#), "{json}");

        let sib_id = core.resolve_paragraph_by_path(0, ppi, &sibling).unwrap().char_shape_id_at(0).unwrap_or(0);
        assert_eq!(sib_id, before, "중첩 표 이웃 셀은 불변");
        let host_after = core
            .get_cell_paragraph_ref(0, ppi, path[0].0, 0, 0)
            .unwrap()
            .char_shape_id_at(0)
            .unwrap_or(0);
        assert_eq!(host_after, host_before, "호스트(바깥) 셀은 불변");

        // 범위 밖 ID·빈 경로는 거부
        let n = core.document.doc_info.char_shapes.len() as u32;
        assert!(core.set_char_shape_id_in_cell_by_path_native(0, ppi, &path, 0, 0, n).is_err());
        assert!(core.set_char_shape_id_in_cell_by_path_native(0, ppi, &[], 0, 0, before).is_err());
    }

    /// 줄 정보 경로 조회: 깊이 1 은 flat 과 같은 JSON, 깊이 2 는 그 중첩 셀 문단의 줄(빈 문단이면 0..0),
    /// 텍스트를 넣으면 charEnd 가 그 셀 문단 길이 — flat 인덱스로는 바깥 문단 기준 셀이라 다른 값이 나오던 것(E6).
    #[test]
    fn line_info_by_path_reads_nested_cell_paragraph() {
        let (mut core, ppi, path) = nested_table_fixture();
        let outer = path[0].0;
        let by_path = compact(&core.get_line_info_by_path_native(0, ppi, &[(outer, 1, 0)], 0).unwrap());
        let flat = compact(&core.get_line_info_in_cell_native(0, ppi, outer, 1, 0, 0).unwrap());
        assert_eq!(by_path, flat, "깊이 1 은 flat 과 같다");

        let empty = compact(&core.get_line_info_by_path_native(0, ppi, &path, 0).unwrap());
        assert!(empty.contains(r#""charStart":0,"charEnd":0"#), "{empty}");

        core.insert_text_in_cell_by_path(0, ppi, &path, 0, "수집·이용 목적").unwrap();
        let n = core.resolve_paragraph_by_path(0, ppi, &path).unwrap().text.chars().count();
        let filled = compact(&core.get_line_info_by_path_native(0, ppi, &path, 0).unwrap());
        assert!(filled.contains(&format!(r#""charEnd":{}"#, n)), "{filled} (len {n})");
        assert!(core.get_line_info_by_path_native(0, ppi, &[], 0).is_err(), "빈 경로 거부");
    }

    /// 깊이 2 셀에 폭보다 긴 글을 넣으면 줄나눔(line_segs 여러 개)이 생기고, 같은 폭의 깊이 1 셀과 줄 수가 같다.
    /// 삭제로 짧아지면 줄 수가 줄고, vpos 는 문단 순서대로 쌓인다 — issue 20260904-223500(지원동기 칸이 한 줄로 셀 밖까지).
    #[test]
    fn nested_cell_insert_delete_reflows_line_segs_like_depth1() {
        let (mut core, ppi, path) = nested_table_fixture();
        let outer = path[0].0;
        // 제품 서식처럼 안쪽 표를 글자처럼 취급(TAC) — 호스트 문단 줄 높이가 안쪽 표 선언 높이를 따르는 경우
        core.get_table_mut_by_path(0, ppi, &path).unwrap().common.treat_as_char = true;
        let host_seg_before = core.get_cell_paragraph_ref(0, ppi, outer, 0, 0).unwrap().line_segs.first().map(|s| s.line_height);
        let long: String = "가".repeat(120);
        // 깊이 1 (바깥 표 셀 1) 과 깊이 2 (안쪽 표 셀 0, 바깥 셀 0 안) — 안쪽 표는 바깥 표의 복제라 셀 폭이 같다
        core.insert_text_in_cell_by_path(0, ppi, &[(outer, 1, 0)], 0, &long).unwrap();
        core.insert_text_in_cell_by_path(0, ppi, &path, 0, &long).unwrap();
        let depth1_lines = core.get_cell_paragraph_ref(0, ppi, outer, 1, 0).unwrap().line_segs.len();
        let nested_lines = core.resolve_paragraph_by_path(0, ppi, &path).unwrap().line_segs.len();
        assert!(depth1_lines > 1, "깊이 1 은 줄바꿈된다 ({depth1_lines})");
        assert_eq!(nested_lines, depth1_lines, "깊이 2 도 같은 폭이면 같은 줄 수");

        // 두 번째 문단을 만들어(분할) vpos 가 첫 문단 아래로 쌓이는지
        core.split_paragraph_in_cell_by_path(0, ppi, &path, 60).unwrap();
        let p0 = core.resolve_paragraph_by_path(0, ppi, &path).unwrap();
        let p1_path = [path[0], (path[1].0, path[1].1, 1)];
        let p1 = core.resolve_paragraph_by_path(0, ppi, &p1_path).unwrap();
        assert!(p0.line_segs.len() >= 1 && p1.line_segs.len() >= 1);
        let p0_last_v = p0.line_segs.last().unwrap().vertical_pos;
        let p1_first_v = p1.line_segs.first().unwrap().vertical_pos;
        assert!(p1_first_v > p0_last_v, "분할된 둘째 문단은 첫 문단 아래 (p0 last {p0_last_v} < p1 first {p1_first_v})");

        // 바깥 전파: 안쪽 표 선언 높이(sz)가 콘텐츠 프레임으로 올라가고, 호스트 문단의 줄 높이가 그 값을 따른다
        let inner_h = core.resolve_table_by_path(0, ppi, &path).unwrap().common.height;
        let host = core.get_cell_paragraph_ref(0, ppi, outer, 0, 0).unwrap();
        assert!(inner_h > 0, "안쪽 표 sz 갱신");
        assert_eq!(host.line_segs.first().map(|s| s.line_height), Some(inner_h as i32), "호스트 문단 줄 높이 = 안쪽 표 sz (전 {host_seg_before:?})");
        assert_ne!(host.line_segs.first().map(|s| s.line_height), host_seg_before, "호스트 줄 높이가 바뀌었다");
        let host_before_delete = inner_h;

        // 삭제로 짧아지면 줄 수가 준다
        let n = p1.text.chars().count();
        core.delete_text_in_cell_by_path(0, ppi, &p1_path, 0, n).unwrap();
        let p1 = core.resolve_paragraph_by_path(0, ppi, &p1_path).unwrap();
        assert!(p1.line_segs.len() <= 1, "빈 문단은 줄 하나 ({})", p1.line_segs.len());
        let inner_h2 = core.resolve_table_by_path(0, ppi, &path).unwrap().common.height;
        assert!(inner_h2 < host_before_delete, "줄이 줄면 안쪽 표 sz 도 준다 ({host_before_delete} → {inner_h2})");
    }

    /// 문단 서식: 경로로 정렬을 바꾸면 paraShapeId 가 바뀌고, 그 ID 를 되돌리면 원래대로.
    #[test]
    fn apply_para_format_by_path_and_restore_para_shape_id() {
        use crate::document_core::helpers::json_u32;
        let (mut core, ppi, path) = nested_table_fixture();
        let before_id = core.resolve_paragraph_by_path(0, ppi, &path).unwrap().para_shape_id;
        let before_json = core.get_para_properties_by_path_native(0, ppi, &path).unwrap();
        assert_eq!(json_u32(&before_json, "paraShapeId").unwrap() as u16, before_id);

        core.apply_para_format_in_cell_by_path_native(0, ppi, &path, r#"{"alignment":"center"}"#)
            .unwrap();
        let after_json = compact(&core.get_para_properties_by_path_native(0, ppi, &path).unwrap());
        assert!(after_json.contains(r#""alignment":"center""#), "{after_json}");
        let after_id = core.resolve_paragraph_by_path(0, ppi, &path).unwrap().para_shape_id;
        assert_ne!(after_id, before_id);

        // 이웃 셀 불변
        let sibling = [path[0], (path[1].0, 1, 0)];
        assert_eq!(
            core.resolve_paragraph_by_path(0, ppi, &sibling).unwrap().para_shape_id,
            before_id
        );

        core.set_para_shape_id_by_path_native(0, ppi, &path, before_id).unwrap();
        assert_eq!(
            core.resolve_paragraph_by_path(0, ppi, &path).unwrap().para_shape_id,
            before_id
        );
        assert!(core.set_para_shape_id_by_path_native(0, ppi, &path, u16::MAX).is_err());
    }

    /// 스타일: 경로로 문단 스타일을 적용하면 style_id 가 바뀌고 조회가 그 이름을 돌려준다.
    #[test]
    fn apply_style_by_path_sets_nested_cell_style() {
        let (mut core, ppi, path) = nested_table_fixture();
        let styles = &core.document.doc_info.styles;
        // 현재와 다른 문단 스타일(style_type 0) 하나 고른다
        let current = core.resolve_paragraph_by_path(0, ppi, &path).unwrap().style_id as usize;
        let target = styles
            .iter()
            .enumerate()
            .find(|(i, s)| *i != current && s.style_type == 0)
            .map(|(i, _)| i)
            .expect("빈 문서에도 문단 스타일이 둘 이상");
        let target_name = styles[target].local_name.clone();

        core.apply_style_by_path_native(0, ppi, &path, target).unwrap();
        assert_eq!(core.resolve_paragraph_by_path(0, ppi, &path).unwrap().style_id as usize, target);
        let json = core.get_style_by_path_native(0, ppi, &path).unwrap();
        assert_eq!(json, format!("{{\"id\":{},\"name\":\"{}\"}}", target, super::json_escape(&target_name)));

        // 이웃 셀 불변
        let sibling = [path[0], (path[1].0, 1, 0)];
        assert_eq!(core.resolve_paragraph_by_path(0, ppi, &sibling).unwrap().style_id as usize, current);
        assert!(core.apply_style_by_path_native(0, ppi, &path, 9999).is_err());
    }

    /// 빈 경로·잘못된 경로는 오류로 돌려보낸다 (조용히 무동작하지 않는다).
    #[test]
    fn by_path_format_apis_reject_empty_and_bad_paths() {
        let (mut core, ppi, path) = nested_table_fixture();
        assert!(core.apply_char_format_in_cell_by_path_native(0, ppi, &[], 0, 0, "{}").is_err());
        assert!(core.apply_para_format_in_cell_by_path_native(0, ppi, &[], "{}").is_err());
        assert!(core.set_para_shape_id_by_path_native(0, ppi, &[], 0).is_err());
        assert!(core.apply_style_by_path_native(0, ppi, &[], 0).is_err());
        let bad = [path[0], (path[1].0, 99, 0)];
        assert!(core.apply_char_format_in_cell_by_path_native(0, ppi, &bad, 0, 0, "{}").is_err());
        assert!(core.get_char_properties_by_path_native(0, ppi, &bad, 0).is_err());
        // 빈 경로 조회는 본문 문단
        let body = core.get_char_properties_by_path_native(0, 0, &[], 0).unwrap();
        assert!(body.contains("fontSize"), "{body}");
    }
}
