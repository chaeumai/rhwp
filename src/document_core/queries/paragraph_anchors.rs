//! 최상위 문단 앵커 일괄 조회 — 한채움 fork (서식 묶음 나누기 2단계).
//!
//! 호스트가 `getPageSvg` 로 그린 쪽 위에 "이 문단 앞에서 자른다" 는 선을 실제 y 좌표로
//! 그리려면 모든 최상위 문단의 첫 줄 위치가 필요하다. `getCursorRect(section, para, 0)` 을
//! 문단마다 RPC 로 부르면 수백 번 왕복이라 하나로 묶는다. 결과는 문단마다
//! `get_cursor_rect_native(s, p, 0)` 과 같다(회귀 테스트로 고정).
//!
//! 계약: hanchaeum `docs/plans/2026-08-25/rhwp-getParagraphAnchors-RPC-계약.md` §2.

use super::super::helpers::json_f64;
use super::super::DocumentCore;
use crate::model::control::Control;
use crate::renderer::render_tree::{RenderNode, RenderNodeType};

/// 문단 하나의 앵커.
#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphAnchor {
    pub section: usize,
    pub paragraph: usize,
    /// 조판되지 않은 문단은 -1.
    pub page_index: i64,
    pub x: f64,
    pub y: f64,
    pub height: f64,
    /// `table` | `text` | `empty` | `object`
    pub kind: &'static str,
}

impl DocumentCore {
    /// 모든 구역의 최상위 문단(표 셀·글상자·각주 안 문단 제외)을 문서 순서대로 훑어
    /// 첫 줄의 쪽·좌표를 모은다. 인덱스는 파서가 세운 `sections[s].paragraphs[p]` 그대로다.
    pub fn paragraph_anchors_native(&self) -> Vec<ParagraphAnchor> {
        let mut out = Vec::new();
        for (s, section) in self.document.sections.iter().enumerate() {
            for (p, para) in section.paragraphs.iter().enumerate() {
                let kind = classify_paragraph(para);
                // 표 문단은 표 상단이 앵커다(계약 §2.2). 문단의 커서 줄은 표 뒤(쪽 하단)에
                // 놓이고, 빈 표 문단은 커서 줄 자체가 없어 실패하므로 렌더 트리의 표 bbox 를 쓴다.
                let table_top = if kind == "table" { self.table_top_anchor(s, p) } else { None };
                let (page_index, x, y, height) = match table_top {
                    Some(hit) => hit,
                    None => match self.get_cursor_rect_native(s, p, 0) {
                        Ok(json) => (
                            json_f64(&json, "pageIndex").map(|v| v as i64).unwrap_or(-1),
                            json_f64(&json, "x").unwrap_or(0.0),
                            json_f64(&json, "y").unwrap_or(0.0),
                            json_f64(&json, "height").unwrap_or(0.0),
                        ),
                        Err(_) => (-1, 0.0, 0.0, 0.0),
                    },
                };
                out.push(ParagraphAnchor {
                    section: s,
                    paragraph: p,
                    page_index,
                    x,
                    y,
                    height,
                    kind,
                });
            }
        }
        out
    }

    /// 표 문단의 앵커 — 표가 처음 놓인 쪽의 렌더 트리에서 그 문단의 표 노드 중 가장 위 bbox.
    /// `height` 는 첫 행 셀 높이(없으면 표 높이). 표 노드를 못 찾으면 None (커서 줄로 폴백).
    fn table_top_anchor(&self, section: usize, para: usize) -> Option<(i64, f64, f64, f64)> {
        let pages = self.find_pages_for_paragraph(section, para).ok()?;
        let first = *pages.first()?;
        let tree = self.build_page_tree_cached(first).ok()?;
        let mut best: Option<(f64, f64, f64)> = None;
        find_table_top(&tree.root, section, para, &mut best);
        best.map(|(x, y, h)| (first as i64, x, y, h))
    }

    /// `paragraph_anchors_native` 를 JSON 배열 문자열로.
    ///
    /// 반환: `[{"section":0,"paragraph":0,"pageIndex":0,"x":F,"y":F,"height":F,"kind":"text"},…]`
    /// 좌표 단위는 `getCursorRect`·`renderPageSvg` 와 같은 px(문서 DPI 기준).
    pub fn paragraph_anchors_json_native(&self) -> String {
        let anchors = self.paragraph_anchors_native();
        let mut s = String::with_capacity(anchors.len() * 96 + 2);
        s.push('[');
        for (i, a) in anchors.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&format!(
                "{{\"section\":{},\"paragraph\":{},\"pageIndex\":{},\"x\":{:.2},\"y\":{:.2},\"height\":{:.2},\"kind\":\"{}\"}}",
                a.section, a.paragraph, a.page_index, a.x, a.y, a.height, a.kind
            ));
        }
        s.push(']');
        s
    }
}

fn find_table_top(node: &RenderNode, section: usize, para: usize, best: &mut Option<(f64, f64, f64)>) {
    if let RenderNodeType::Table(tn) = &node.node_type {
        if tn.section_index == Some(section) && tn.para_index == Some(para) {
            let first_row_height = node
                .children
                .iter()
                .filter_map(|c| match &c.node_type {
                    RenderNodeType::TableCell(tc) if tc.row == 0 => Some(c.bbox.height),
                    _ => None,
                })
                .fold(None, |acc: Option<f64>, h| Some(acc.map_or(h, |a| a.min(h))))
                .unwrap_or(node.bbox.height);
            let candidate = (node.bbox.x, node.bbox.y, first_row_height);
            if best.map_or(true, |b| candidate.1 < b.1) {
                *best = Some(candidate);
            }
            // 중첩 표는 이 문단 것이 아니다 — 더 내려가지 않는다.
            return;
        }
    }
    for child in &node.children {
        find_table_top(child, section, para, best);
    }
}

/// 본체 `HwpxSectionScanner` 의 분류(TABLE/TEXT/EMPTY/OBJECT)와 같은 뜻으로 맞춘다.
/// 표가 하나라도 있으면 표 문단, 그림·도형·수식·양식 개체가 있으면 개체 문단,
/// 글자가 공백뿐이고 개체도 없으면 빈 문단.
fn classify_paragraph(para: &crate::model::paragraph::Paragraph) -> &'static str {
    let mut has_object = false;
    for ctrl in &para.controls {
        match ctrl {
            Control::Table(_) => return "table",
            Control::Shape(_)
            | Control::Picture(_)
            | Control::Equation(_)
            | Control::Form(_) => has_object = true,
            _ => {}
        }
    }
    if has_object {
        return "object";
    }
    let has_text = para
        .text
        .chars()
        .any(|c| !c.is_whitespace() && !c.is_control());
    if has_text {
        "text"
    } else {
        "empty"
    }
}
