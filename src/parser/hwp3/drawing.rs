//! HWP3 그리기 객체 파싱
//!
//! HWP3 파일에 포함된 그리기 객체(선, 사각형, 타원, 그룹 등)를 파싱하여 렌더링 가능한 모델로 변환한다.
//! 그리기 객체의 계층 구조(트리)와 캡션, 속성 정보 등을 추출하는 역할을 한다.

use crate::parser::hwp3::encoding::decode_hwp3_string;
use byteorder::{LittleEndian, ReadBytesExt};
use std::io::{self, Read, Seek, SeekFrom};

#[derive(Debug, Default)]
pub struct Hwp3DrawingObjectFrameHeader {
    pub header_length: u32,
    pub z_order: u32,
    pub object_count: u32,
    pub bounds: [i32; 4], // shunit32 (x, y, 너비, 높이)
}

impl Hwp3DrawingObjectFrameHeader {
    pub fn read<R: Read>(mut reader: R) -> Result<Self, io::Error> {
        let header_length = reader.read_u32::<LittleEndian>()?;
        let z_order = reader.read_u32::<LittleEndian>()?;
        let object_count = reader.read_u32::<LittleEndian>()?;
        let bounds = [
            reader.read_i32::<LittleEndian>()?,
            reader.read_i32::<LittleEndian>()?,
            reader.read_i32::<LittleEndian>()?,
            reader.read_i32::<LittleEndian>()?,
        ];

        Ok(Hwp3DrawingObjectFrameHeader {
            header_length,
            z_order,
            object_count,
            bounds,
        })
    }
}

#[derive(Debug, Default)]
pub struct Hwp3DrawingObjectHypertextInfo {
    pub length: u32,
    pub jump_file_name: String, // 256 kchar
    pub jump_bookmark: String,  // 16 hchar (보통 32 바이트지만 문서에 따라 16 바이트로 처리)
    pub macro_data: Vec<u8>,    // 325 바이트
    pub kind: u8,
    pub reserved: [u8; 3],
}

impl Hwp3DrawingObjectHypertextInfo {
    pub fn read<R: Read>(mut reader: R) -> Result<Self, io::Error> {
        let length = reader.read_u32::<LittleEndian>()?;
        let mut jump_file_name_buf = [0u8; 256];
        reader.read_exact(&mut jump_file_name_buf)?;
        let jump_file_name = decode_hwp3_string(&jump_file_name_buf);

        let mut jump_bookmark_buf = [0u8; 16]; // 문서에는 16 hchar(32바이트)로 명시되어 있으나, 오프셋 계산상 16바이트로 처리함
        reader.read_exact(&mut jump_bookmark_buf)?;
        let jump_bookmark = decode_hwp3_string(&jump_bookmark_buf);

        let mut macro_data = vec![0u8; 325];
        reader.read_exact(&mut macro_data)?;

        let kind = reader.read_u8()?;
        let mut reserved = [0u8; 3];
        reader.read_exact(&mut reserved)?;

        Ok(Hwp3DrawingObjectHypertextInfo {
            length,
            jump_file_name,
            jump_bookmark,
            macro_data,
            kind,
            reserved,
        })
    }
}

#[derive(Debug, Default)]
pub struct Hwp3DrawingObjectBasicAttr {
    pub line_style: u32,
    pub arrow_end: u32,
    pub arrow_start: u32,
    pub line_color: u32,
    pub line_width: u32,
    pub fill_color: u32,
    pub pattern_type: u32,
    pub pattern_color: u32,
    pub textbox_margin: [u32; 2],
    pub options: u32,
}

impl Hwp3DrawingObjectBasicAttr {
    pub fn read<R: Read>(mut reader: R) -> Result<Self, io::Error> {
        Ok(Hwp3DrawingObjectBasicAttr {
            line_style: reader.read_u32::<LittleEndian>()?,
            arrow_end: reader.read_u32::<LittleEndian>()?,
            arrow_start: reader.read_u32::<LittleEndian>()?,
            line_color: reader.read_u32::<LittleEndian>()?,
            line_width: reader.read_u32::<LittleEndian>()?,
            fill_color: reader.read_u32::<LittleEndian>()?,
            pattern_type: reader.read_u32::<LittleEndian>()?,
            pattern_color: reader.read_u32::<LittleEndian>()?,
            textbox_margin: [
                reader.read_u32::<LittleEndian>()?,
                reader.read_u32::<LittleEndian>()?,
            ],
            options: reader.read_u32::<LittleEndian>()?,
        })
    }

    pub fn has_gradient(&self) -> bool {
        (self.options & (1 << 16)) != 0
    }

    pub fn has_rotation(&self) -> bool {
        (self.options & (1 << 17)) != 0
    }

    pub fn has_bitmap_pattern(&self) -> bool {
        (self.options & (1 << 18)) != 0
    }
}

#[derive(Debug, Default)]
pub struct Hwp3DrawingObjectRotationAttr {
    pub center_x: i32,
    pub center_y: i32,
    pub parallelogram: [i32; 6],
}

impl Hwp3DrawingObjectRotationAttr {
    pub fn read<R: Read>(mut reader: R) -> Result<Self, io::Error> {
        Ok(Hwp3DrawingObjectRotationAttr {
            center_x: reader.read_i32::<LittleEndian>()?,
            center_y: reader.read_i32::<LittleEndian>()?,
            parallelogram: [
                reader.read_i32::<LittleEndian>()?,
                reader.read_i32::<LittleEndian>()?,
                reader.read_i32::<LittleEndian>()?,
                reader.read_i32::<LittleEndian>()?,
                reader.read_i32::<LittleEndian>()?,
                reader.read_i32::<LittleEndian>()?,
            ],
        })
    }
}

#[derive(Debug, Default)]
pub struct Hwp3DrawingObjectGradientAttr {
    pub start_color: u32,
    pub end_color: u32,
    pub kind: u32,
    pub angle: u32,
    pub center_x: u32,
    pub center_y: u32,
    pub step: u32,
}

impl Hwp3DrawingObjectGradientAttr {
    pub fn read<R: Read>(mut reader: R) -> Result<Self, io::Error> {
        Ok(Hwp3DrawingObjectGradientAttr {
            start_color: reader.read_u32::<LittleEndian>()?,
            end_color: reader.read_u32::<LittleEndian>()?,
            kind: reader.read_u32::<LittleEndian>()?,
            angle: reader.read_u32::<LittleEndian>()?,
            center_x: reader.read_u32::<LittleEndian>()?,
            center_y: reader.read_u32::<LittleEndian>()?,
            step: reader.read_u32::<LittleEndian>()?,
        })
    }
}

#[derive(Debug, Default)]
pub struct Hwp3DrawingObjectBitmapPatternAttr {
    pub start_pos: [u32; 2],
    pub end_pos: [u32; 2],
    pub file_name: String, // 261 바이트
    pub option: u8,
}

impl Hwp3DrawingObjectBitmapPatternAttr {
    pub fn read<R: Read>(mut reader: R) -> Result<Self, io::Error> {
        let start_pos = [
            reader.read_u32::<LittleEndian>()?,
            reader.read_u32::<LittleEndian>()?,
        ];
        let end_pos = [
            reader.read_u32::<LittleEndian>()?,
            reader.read_u32::<LittleEndian>()?,
        ];
        let mut file_name_buf = [0u8; 261];
        reader.read_exact(&mut file_name_buf)?;
        let file_name = decode_hwp3_string(&file_name_buf);
        let option = reader.read_u8()?;

        Ok(Hwp3DrawingObjectBitmapPatternAttr {
            start_pos,
            end_pos,
            file_name,
            option,
        })
    }
}

#[derive(Debug, Default)]
pub struct Hwp3DrawingObjectCommonHeader {
    pub header_length: u32,
    pub object_type: u16,
    pub connection_info: u16,
    pub relative_pos: [u32; 2],
    pub object_size: [u32; 2],
    pub absolute_pos: [u32; 2],
    pub bounds: [i32; 4],
    pub basic_attr: Hwp3DrawingObjectBasicAttr,
    pub rotation_attr: Option<Hwp3DrawingObjectRotationAttr>,
    pub gradient_attr: Option<Hwp3DrawingObjectGradientAttr>,
    pub bitmap_pattern_attr: Option<Hwp3DrawingObjectBitmapPatternAttr>,
}

impl Hwp3DrawingObjectCommonHeader {
    pub fn read<R: Read>(mut reader: R) -> Result<Self, io::Error> {
        let header_length = reader.read_u32::<LittleEndian>()?;
        let object_type = reader.read_u16::<LittleEndian>()?;
        let connection_info = reader.read_u16::<LittleEndian>()?;
        let relative_pos = [
            reader.read_u32::<LittleEndian>()?,
            reader.read_u32::<LittleEndian>()?,
        ];
        let object_size = [
            reader.read_u32::<LittleEndian>()?,
            reader.read_u32::<LittleEndian>()?,
        ];
        let absolute_pos = [
            reader.read_u32::<LittleEndian>()?,
            reader.read_u32::<LittleEndian>()?,
        ];
        let bounds = [
            reader.read_i32::<LittleEndian>()?,
            reader.read_i32::<LittleEndian>()?,
            reader.read_i32::<LittleEndian>()?,
            reader.read_i32::<LittleEndian>()?,
        ];

        let basic_attr = Hwp3DrawingObjectBasicAttr::read(&mut reader)?;

        let rotation_attr = if basic_attr.has_rotation() {
            Some(Hwp3DrawingObjectRotationAttr::read(&mut reader)?)
        } else {
            None
        };

        let gradient_attr = if basic_attr.has_gradient() {
            Some(Hwp3DrawingObjectGradientAttr::read(&mut reader)?)
        } else {
            None
        };

        let bitmap_pattern_attr = if basic_attr.has_bitmap_pattern() {
            Some(Hwp3DrawingObjectBitmapPatternAttr::read(&mut reader)?)
        } else {
            None
        };

        Ok(Hwp3DrawingObjectCommonHeader {
            header_length,
            object_type,
            connection_info,
            relative_pos,
            object_size,
            absolute_pos,
            bounds,
            basic_attr,
            rotation_attr,
            gradient_attr,
            bitmap_pattern_attr,
        })
    }
}

// 개체별 세부 정보
#[derive(Debug)]
pub enum Hwp3DrawingObject {
    Container(Hwp3DrawingObjectCommonHeader),
    Line(Hwp3DrawingObjectCommonHeader, Hwp3DrawingLine),
    Rectangle(Hwp3DrawingObjectCommonHeader),
    Ellipse(Hwp3DrawingObjectCommonHeader),
    Arc(Hwp3DrawingObjectCommonHeader, Hwp3DrawingArc),
    Polygon(Hwp3DrawingObjectCommonHeader, Hwp3DrawingPolygon),
    TextBox(Hwp3DrawingObjectCommonHeader, Hwp3DrawingTextBox),
    Curve(Hwp3DrawingObjectCommonHeader, Hwp3DrawingCurve),
    ModifiedEllipse(Hwp3DrawingObjectCommonHeader, Hwp3DrawingModifiedEllipse),
    ModifiedArc(Hwp3DrawingObjectCommonHeader), // 공통 헤더 외에 추가적인 세부 정보 없음
    ExtendedCurve(Hwp3DrawingObjectCommonHeader, Hwp3DrawingExtendedPolygon),
    ClosedPolygon(Hwp3DrawingObjectCommonHeader, Hwp3DrawingExtendedPolygon),
    Unknown(Hwp3DrawingObjectCommonHeader, Vec<u8>),
}

#[derive(Debug, Default)]
pub struct Hwp3DrawingLine {
    pub info1_len: u32,
    pub shape_info: u32,
    pub info2_len: u32,
}

impl Hwp3DrawingLine {
    pub fn read<R: Read>(mut reader: R) -> Result<Self, io::Error> {
        Ok(Hwp3DrawingLine {
            info1_len: reader.read_u32::<LittleEndian>()?,
            shape_info: reader.read_u32::<LittleEndian>()?,
            info2_len: reader.read_u32::<LittleEndian>()?,
        })
    }
}

#[derive(Debug, Default)]
pub struct Hwp3DrawingArc {
    pub info1_len: u32,
    pub shape_info: u32,
    pub info2_len: u32,
}

impl Hwp3DrawingArc {
    pub fn read<R: Read>(mut reader: R) -> Result<Self, io::Error> {
        Ok(Hwp3DrawingArc {
            info1_len: reader.read_u32::<LittleEndian>()?,
            shape_info: reader.read_u32::<LittleEndian>()?,
            info2_len: reader.read_u32::<LittleEndian>()?,
        })
    }
}

#[derive(Debug, Default)]
pub struct Hwp3DrawingPolygon {
    pub info1_len: u32,
    pub point_count: u32,
    pub info2_len: u32,
    pub points: Vec<[i32; 2]>,
}

impl Hwp3DrawingPolygon {
    pub fn read<R: Read>(mut reader: R) -> Result<Self, io::Error> {
        let info1_len = reader.read_u32::<LittleEndian>()?;
        let point_count = reader.read_u32::<LittleEndian>()?;
        let info2_len = reader.read_u32::<LittleEndian>()?;
        super::check_record_count(point_count as usize)?;
        let mut points = Vec::with_capacity(point_count as usize);
        for _ in 0..point_count {
            points.push([
                reader.read_i32::<LittleEndian>()?,
                reader.read_i32::<LittleEndian>()?,
            ]);
        }
        Ok(Hwp3DrawingPolygon {
            info1_len,
            point_count,
            info2_len,
            points,
        })
    }
}

#[derive(Debug, Default)]
pub struct Hwp3DrawingTextBox {
    pub info1_len: u32,
    pub info2_len: u32,
    pub paragraph_list_data: Vec<u8>,
}

impl Hwp3DrawingTextBox {
    pub fn read<R: Read>(mut reader: R) -> Result<Self, io::Error> {
        let info1_len = reader.read_u32::<LittleEndian>()?;
        let info2_len = reader.read_u32::<LittleEndian>()?;
        let mut paragraph_list_data = super::alloc_record_buf(info2_len as usize)?;
        if info2_len > 0 {
            reader.read_exact(&mut paragraph_list_data)?;
        }
        Ok(Hwp3DrawingTextBox {
            info1_len,
            info2_len,
            paragraph_list_data,
        })
    }
}

#[derive(Debug, Default)]
pub struct Hwp3DrawingCurve {
    pub info1_len: u32,
    pub point_count: u32,
    pub info2_len: u32,
    pub points: Vec<[i32; 2]>,
}

impl Hwp3DrawingCurve {
    pub fn read<R: Read>(mut reader: R) -> Result<Self, io::Error> {
        let info1_len = reader.read_u32::<LittleEndian>()?;
        let point_count = reader.read_u32::<LittleEndian>()?;
        let info2_len = reader.read_u32::<LittleEndian>()?;
        super::check_record_count(point_count as usize)?;
        let mut points = Vec::with_capacity(point_count as usize);
        for _ in 0..point_count {
            points.push([
                reader.read_i32::<LittleEndian>()?,
                reader.read_i32::<LittleEndian>()?,
            ]);
        }
        Ok(Hwp3DrawingCurve {
            info1_len,
            point_count,
            info2_len,
            points,
        })
    }
}

#[derive(Debug, Default)]
pub struct Hwp3DrawingModifiedEllipse {
    pub info1_len: u32,
    pub arc_bounds: [i32; 4],
    pub info2_len: u32,
}

impl Hwp3DrawingModifiedEllipse {
    pub fn read<R: Read>(mut reader: R) -> Result<Self, io::Error> {
        Ok(Hwp3DrawingModifiedEllipse {
            info1_len: reader.read_u32::<LittleEndian>()?,
            arc_bounds: [
                reader.read_i32::<LittleEndian>()?,
                reader.read_i32::<LittleEndian>()?,
                reader.read_i32::<LittleEndian>()?,
                reader.read_i32::<LittleEndian>()?,
            ],
            info2_len: reader.read_u32::<LittleEndian>()?,
        })
    }
}

#[derive(Debug, Default)]
pub struct Hwp3DrawingExtendedPolygon {
    pub info1_len: u32,
    pub point_count: u32,
    pub info2_len: u32,
    pub points: Vec<[i32; 2]>,
    pub line_attrs: Vec<u8>,
}

impl Hwp3DrawingExtendedPolygon {
    pub fn read<R: Read>(mut reader: R) -> Result<Self, io::Error> {
        let info1_len = reader.read_u32::<LittleEndian>()?;
        let point_count = reader.read_u32::<LittleEndian>()?;
        let info2_len = reader.read_u32::<LittleEndian>()?;
        super::check_record_count(point_count as usize)?;
        let mut points = Vec::with_capacity(point_count as usize);
        for _ in 0..point_count {
            points.push([
                reader.read_i32::<LittleEndian>()?,
                reader.read_i32::<LittleEndian>()?,
            ]);
        }
        let mut line_attrs = super::alloc_record_buf(point_count as usize)?;
        if point_count > 0 {
            reader.read_exact(&mut line_attrs)?;
        }
        Ok(Hwp3DrawingExtendedPolygon {
            info1_len,
            point_count,
            info2_len,
            points,
            line_attrs,
        })
    }
}

impl Hwp3DrawingObject {
    pub fn read<R: Read + Seek>(mut reader: R) -> Result<Self, io::Error> {
        let header = Hwp3DrawingObjectCommonHeader::read(&mut reader)?;

        // 글상자(6)인 경우, 공통 헤더 바로 뒤에 글상자 정보가 위치함.
        // 테이블 78 "글상자 세부 정보"에 따라 info1_len, info2_len, 문단 리스트가 존재함.
        // 이는 아래에서 처리됨.

        match header.object_type {
            0 => {
                // 컨테이너: 추가 세부 길이 정보 없음
                Ok(Hwp3DrawingObject::Container(header))
            }
            1 => {
                let details = Hwp3DrawingLine::read(&mut reader)?;
                Ok(Hwp3DrawingObject::Line(header, details))
            }
            2 => {
                // 사각형: 세부 정보가 없으면 0으로 채워진 8바이트. 테이블 73에 info1_len=0, info2_len=0으로 명시됨.
                // 단순한 도형의 경우 8바이트를 읽고 무시함.
                let _info1_len = reader.read_u32::<LittleEndian>()?;
                let _info2_len = reader.read_u32::<LittleEndian>()?;
                Ok(Hwp3DrawingObject::Rectangle(header))
            }
            3 => {
                // 타원: 0으로 채워진 8바이트
                let _info1_len = reader.read_u32::<LittleEndian>()?;
                let _info2_len = reader.read_u32::<LittleEndian>()?;
                Ok(Hwp3DrawingObject::Ellipse(header))
            }
            4 => {
                let details = Hwp3DrawingArc::read(&mut reader)?;
                Ok(Hwp3DrawingObject::Arc(header, details))
            }
            5 => {
                let details = Hwp3DrawingPolygon::read(&mut reader)?;
                Ok(Hwp3DrawingObject::Polygon(header, details))
            }
            6 => {
                let details = Hwp3DrawingTextBox::read(&mut reader)?;
                // 글상자일 경우 공통 헤더 뒤에 글상자 정보가 저장된다...
                // 세부 정보가 존재하지 않을 때는 길이 값들이 0이 되어 8개의 연속된 0으로 표현된다.
                // 테이블 78이 글상자의 세부 정보이므로, 세부 정보를 이미 읽었다고 가정함.
                Ok(Hwp3DrawingObject::TextBox(header, details))
            }
            7 => {
                let details = Hwp3DrawingCurve::read(&mut reader)?;
                Ok(Hwp3DrawingObject::Curve(header, details))
            }
            8 => {
                let details = Hwp3DrawingModifiedEllipse::read(&mut reader)?;
                Ok(Hwp3DrawingObject::ModifiedEllipse(header, details))
            }
            9 => {
                // 수정된 호
                let _info1_len = reader.read_u32::<LittleEndian>()?;
                let _info2_len = reader.read_u32::<LittleEndian>()?;
                Ok(Hwp3DrawingObject::ModifiedArc(header))
            }
            10 => {
                let details = Hwp3DrawingExtendedPolygon::read(&mut reader)?;
                Ok(Hwp3DrawingObject::ExtendedCurve(header, details))
            }
            11 => {
                // 닫힌 다각형이 11일 것으로 추정. 명세서에 번호가 명시되지 않음.
                // 실제로 명세서에는 10은 "확장된 곡선"이며, "닫혀진 다각형"은 테이블에 ID가 없음.
                // 확장된 다각형과 비슷하게 처리한다고 가정함.
                let details = Hwp3DrawingExtendedPolygon::read(&mut reader)?;
                Ok(Hwp3DrawingObject::ClosedPolygon(header, details))
            }
            _ => {
                // 알 수 없는 객체
                let info1_len = reader.read_u32::<LittleEndian>()?;
                let mut info1 = super::alloc_record_buf(info1_len as usize)?;
                reader.read_exact(&mut info1)?;
                let info2_len = reader.read_u32::<LittleEndian>()?;
                let mut info2 = super::alloc_record_buf(info2_len as usize)?;
                reader.read_exact(&mut info2)?;

                let mut all_data = Vec::new();
                all_data.extend(info1);
                all_data.extend(info2);
                Ok(Hwp3DrawingObject::Unknown(header, all_data))
            }
        }
    }
}

use crate::model::shape::{
    ArcShape, CommonObjAttr, CurveShape, DrawingObjAttr, EllipseShape, GroupShape, LineShape,
    PolygonShape, RectangleShape, ShapeComponentAttr, ShapeObject, TextBox,
};
use crate::model::style::{Fill, FillType, ShapeBorderLine};
use crate::model::Padding;
use crate::parser::hwp3::Hwp3Error;
use std::collections::HashMap;

const HWP3_UNIT_SCALE: i32 = 4;

/// 신뢰할 수 없는 파일에서 읽은 HWP3 raw margin(u32)을 `* HWP3_UNIT_SCALE` 스케일 후
/// `i16` 필드(`TextBox::margin_*`)에 담는다. 곱셈이 `i32`/`i16` 범위를 넘으면 그대로
/// 캐스팅하는 대신 클램프해 오버플로 panic(malformed/fuzzed 파일에서의 DoS)을 막는다.
///
/// [upstream 손이식] chaeumai/rhwp 6bcbadcd1 — 판정은 `docs/upstream-이식-대장.md` §3-2.
fn hwp3_margin_to_i16(raw_margin: u32) -> i16 {
    let scaled = raw_margin as i64 * HWP3_UNIT_SCALE as i64;
    scaled.clamp(i16::MIN as i64, i16::MAX as i64) as i16
}

pub fn parse_drawing_object_tree(
    cursor: &mut std::io::Cursor<&[u8]>,
    doc_char_shapes: &mut Vec<crate::model::style::CharShape>,
    doc_para_shapes: &mut Vec<crate::model::style::ParaShape>,
    doc_border_fills: &mut Vec<crate::model::style::BorderFill>,
    doc_tab_defs: &mut Vec<crate::model::style::TabDef>,
    pic_name_to_id: &mut HashMap<String, u16>,
) -> Result<ShapeObject, Hwp3Error> {
    let frame_header = Hwp3DrawingObjectFrameHeader::read(&mut *cursor)
        .map_err(|e| Hwp3Error::IoError { source: e })?;

    if frame_header.header_length > 24 {
        let _hypertext = Hwp3DrawingObjectHypertextInfo::read(&mut *cursor)
            .map_err(|e| Hwp3Error::IoError { source: e })?;
    }

    if frame_header.object_count == 0 {
        return Err(Hwp3Error::ParseError {
            message: "Drawing object has 0 objects".to_string(),
        });
    }

    let mut root_nodes = parse_shape_list(
        cursor,
        doc_char_shapes,
        doc_para_shapes,
        doc_border_fills,
        doc_tab_defs,
        pic_name_to_id,
        0,
    )?;

    if root_nodes.is_empty() {
        return Err(Hwp3Error::ParseError {
            message: "Failed to parse any root drawing objects".to_string(),
        });
    }

    if root_nodes.len() == 1 {
        Ok(root_nodes.remove(0))
    } else {
        let mut group = GroupShape::default();
        group.children = root_nodes;
        Ok(ShapeObject::Group(group))
    }
}

/// `has_child`(connection_info bit 1)는 파일에서 그대로 온 값이라, 재귀 깊이에
/// 상한이 없으면 중첩된 Container 객체 체인 하나로 네이티브 스택을 고갈시켜
/// 프로세스를 죽일 수 있다(패닉과 달리 `catch_unwind` 로 못 잡음). 최소 92바이트짜리
/// Container 객체를 수만 겹 중첩해도 HWP3 레코드 상한 안에 들어간다.
///
/// [upstream 손이식] chaeumai/rhwp 278d1b297 — 판정은 `docs/upstream-이식-대장.md` §3-2.
const MAX_DRAWING_OBJECT_DEPTH: u32 = 256;

#[allow(clippy::too_many_arguments)]
fn parse_shape_list(
    cursor: &mut std::io::Cursor<&[u8]>,
    doc_char_shapes: &mut Vec<crate::model::style::CharShape>,
    doc_para_shapes: &mut Vec<crate::model::style::ParaShape>,
    doc_border_fills: &mut Vec<crate::model::style::BorderFill>,
    doc_tab_defs: &mut Vec<crate::model::style::TabDef>,
    pic_name_to_id: &mut HashMap<String, u16>,
    depth: u32,
) -> Result<Vec<ShapeObject>, Hwp3Error> {
    if depth > MAX_DRAWING_OBJECT_DEPTH {
        return Err(Hwp3Error::ParseError {
            message: format!(
                "Drawing object nesting exceeds {} levels",
                MAX_DRAWING_OBJECT_DEPTH
            ),
        });
    }
    let mut list = Vec::new();
    loop {
        let raw_obj =
            Hwp3DrawingObject::read(&mut *cursor).map_err(|e| Hwp3Error::IoError { source: e })?;

        let (mut node, connection_info) = map_to_shape_object(
            raw_obj,
            doc_char_shapes,
            doc_para_shapes,
            doc_border_fills,
            doc_tab_defs,
            pic_name_to_id,
        )?;

        let has_sibling = (connection_info & 0x01) != 0;
        let has_child = (connection_info & 0x02) != 0;

        if has_child {
            let children = parse_shape_list(
                cursor,
                doc_char_shapes,
                doc_para_shapes,
                doc_border_fills,
                doc_tab_defs,
                pic_name_to_id,
                depth + 1,
            )?;
            if let ShapeObject::Group(ref mut g) = node {
                g.children = children;
            } else {
                eprintln!("HWP3 그리기 객체에서 컨테이너가 아닌 도형이 자식을 가짐");
            }
        }

        list.push(node);

        if !has_sibling {
            break;
        }
    }
    Ok(list)
}

fn map_to_shape_object(
    raw: Hwp3DrawingObject,
    doc_char_shapes: &mut Vec<crate::model::style::CharShape>,
    doc_para_shapes: &mut Vec<crate::model::style::ParaShape>,
    doc_border_fills: &mut Vec<crate::model::style::BorderFill>,
    doc_tab_defs: &mut Vec<crate::model::style::TabDef>,
    pic_name_to_id: &mut HashMap<String, u16>,
) -> Result<(ShapeObject, u16), Hwp3Error> {
    let mut parsed_paragraphs = Vec::new();

    let (header, shape) = match raw {
        Hwp3DrawingObject::Container(hdr) => (hdr, ShapeObject::Group(GroupShape::default())),
        Hwp3DrawingObject::Line(hdr, _details) => (hdr, ShapeObject::Line(LineShape::default())),
        Hwp3DrawingObject::Rectangle(hdr) => {
            (hdr, ShapeObject::Rectangle(RectangleShape::default()))
        }
        Hwp3DrawingObject::Ellipse(hdr) => (hdr, ShapeObject::Ellipse(EllipseShape::default())),
        Hwp3DrawingObject::Arc(hdr, _details) => (hdr, ShapeObject::Arc(ArcShape::default())),
        Hwp3DrawingObject::Polygon(hdr, _details) => {
            (hdr, ShapeObject::Polygon(PolygonShape::default()))
        }
        Hwp3DrawingObject::TextBox(hdr, details) => {
            if details.info2_len > 0 {
                let mut text_cursor = std::io::Cursor::new(details.paragraph_list_data.as_slice());
                let paras = crate::parser::hwp3::parse_paragraph_list(
                    &mut text_cursor,
                    doc_char_shapes,
                    doc_para_shapes,
                    doc_border_fills,
                    doc_tab_defs,
                    pic_name_to_id,
                    0,            // body_left_hu: 드로잉 내부 텍스트, wrap zone 불필요
                    i32::MAX / 2, // column_width_hu
                    0,            // body_height_hu: 도형 내부 텍스트는 본문 페이지 분할 제외
                )?;
                parsed_paragraphs = paras;
            }
            (hdr, ShapeObject::Rectangle(RectangleShape::default()))
        }
        Hwp3DrawingObject::Curve(hdr, _details) => (hdr, ShapeObject::Curve(CurveShape::default())),
        Hwp3DrawingObject::ModifiedEllipse(hdr, _details) => {
            (hdr, ShapeObject::Ellipse(EllipseShape::default()))
        }
        Hwp3DrawingObject::ModifiedArc(hdr) => (hdr, ShapeObject::Arc(ArcShape::default())),
        Hwp3DrawingObject::ExtendedCurve(hdr, _details) => {
            (hdr, ShapeObject::Curve(CurveShape::default()))
        }
        Hwp3DrawingObject::ClosedPolygon(hdr, _details) => {
            (hdr, ShapeObject::Polygon(PolygonShape::default()))
        }
        Hwp3DrawingObject::Unknown(hdr, _data) => (hdr, ShapeObject::Group(GroupShape::default())),
    };

    let connection_info = header.connection_info;
    let mut final_shape = shape;

    let common = CommonObjAttr {
        width: header.object_size[0].saturating_mul(HWP3_UNIT_SCALE as u32),
        height: header.object_size[1].saturating_mul(HWP3_UNIT_SCALE as u32),
        ..Default::default()
    };

    let mut rotation_angle = 0i16;
    if let Some(ref rot) = header.rotation_attr {
        let x0 = rot.parallelogram[0] as f64;
        let y0 = rot.parallelogram[1] as f64;
        let x1 = rot.parallelogram[2] as f64;
        let y1 = rot.parallelogram[3] as f64;

        let dx = x1 - x0;
        let dy = y1 - y0;
        if dx != 0.0 || dy != 0.0 {
            let mut angle = dy.atan2(dx) * 180.0 / std::f64::consts::PI;
            if angle < 0.0 {
                angle += 360.0;
            }
            rotation_angle = angle.round() as i16;
        }
    }

    let shape_attr = ShapeComponentAttr {
        offset_x: (header.relative_pos[0] as i64 * HWP3_UNIT_SCALE as i64)
            .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        offset_y: (header.relative_pos[1] as i64 * HWP3_UNIT_SCALE as i64)
            .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        original_width: header.object_size[0].saturating_mul(HWP3_UNIT_SCALE as u32),
        original_height: header.object_size[1].saturating_mul(HWP3_UNIT_SCALE as u32),
        current_width: header.object_size[0].saturating_mul(HWP3_UNIT_SCALE as u32),
        current_height: header.object_size[1].saturating_mul(HWP3_UNIT_SCALE as u32),
        rotation_angle,
        ..Default::default()
    };

    let border_line = ShapeBorderLine {
        color: header.basic_attr.line_color,
        width: (header.basic_attr.line_width as i64 * HWP3_UNIT_SCALE as i64)
            .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        // [Task #877 Stage 3] HWP3 drawing line_style = 0 (= "선 종류 없음") 인데
        // line_width > 0 인 경우 → 실제 한컴 viewer 는 실선으로 표시. (sample16 RFP
        // 박스 외곽선 회귀: raw line_style=0, line_width=84, line_color=0 검정)
        // 렌더러 [renderer/layout/utils.rs:163] 의 `attr & 0x3F == 0` 시 외곽선 미표시
        // 규칙에 맞추기 위해 bit 0..5 = 1 (Solid LineType) 보강.
        //
        // [Task #1008 격차 B] HWP3 raw line_style 의 LineType=2~7 (점선/일점쇄선
        // 등) 도 한컴 viewer 는 실선으로 렌더 (sample16 pi=71 사업개요 박스 raw
        // line_style=2 → 한컴 정답 = 실선). HWP3 native LineType 변형은 spec
        // 상 존재하나 한컴 동작은 일관 solid — 작업지시자 한컴 한글 정답지 시각
        // 정답 단언. HWP3 sample 분포 sweep: line_style=2 는 sample16 한정 (다른
        // fixture: 0/1 만), narrow fix 회귀 risk 0. HWP3 한정 (HWP5/HWPX 무영향).
        attr: {
            let raw_attr = header.basic_attr.line_style as u32;
            let line_type = raw_attr & 0x3F;
            if line_type == 0 && header.basic_attr.line_width > 0 {
                raw_attr | 0x01
            } else if (2..=7).contains(&line_type) {
                // HWP3 의 LineType 2~7 을 1 (Solid) 로 normalize
                (raw_attr & !0x3F) | 0x01
            } else {
                raw_attr
            }
        },
        outline_style: 0,
    };

    // [Task #877 Stage 4] HWP3 fill_color 의 high byte (bit 24~31) 가 0 이 아니면
    // 한컴 HWP3 의 "기본값 없음/투명" flag 로 추정 (sample16 paragraph 5/131/393:
    // raw 0x10000000 = bit 28 set + RGB 0). rhwp 가 raw 그대로 ColorRef 로 사용
    // → 거의 검정 fill (alpha=0x10) → 외곽선이 fill 위에 안 보이는 회귀.
    //
    // 해결: RGB=0 + high flag set 인 경우 흰색 fill 로 대체. 한컴 viewer 의 실제
    // 표시 (연한 보라 채우기) 와 100% 정합은 아니나 외곽선 가시화로 본질 표현.
    let raw_fc = header.basic_attr.fill_color;
    let fill_flag = (raw_fc >> 24) & 0xFF;
    let fill_rgb = raw_fc & 0x00FFFFFF;
    let effective_rgb = if fill_flag != 0 && fill_rgb == 0 {
        0x00FFFFFF
    } else {
        fill_rgb
    };
    // [Task #1008 격차 A] HWP3 gradient_attr 이 파싱된 경우 IR Fill.gradient 에 매핑.
    // HWP3 raw stream 의 Hwp3DrawingObjectGradientAttr (drawing.rs:149~170) 은 이미
    // basic_attr.has_gradient() 시 파싱되어 header.gradient_attr 에 보존되지만, 종전
    // 코드는 fill_type 을 항상 Solid 로 하드코딩하여 데이터가 무시되었음. HWP5 의
    // doc_info.rs:404 매핑과 동일 contract 로 IR 주입 (step→blur, 2-stop colors,
    // positions=vec![] → renderer 가 균등 분포).
    let (fill_type, gradient) = if let Some(g) = header.gradient_attr.as_ref() {
        let grad = crate::model::style::GradientFill {
            gradient_type: g.kind as i16,
            angle: g.angle as i16,
            center_x: g.center_x as i16,
            center_y: g.center_y as i16,
            blur: g.step as i16,
            step_center: 0,
            colors: vec![g.start_color, g.end_color],
            positions: vec![],
        };
        (crate::model::style::FillType::Gradient, Some(grad))
    } else {
        (crate::model::style::FillType::Solid, None)
    };
    let fill = Fill {
        fill_type,
        solid: Some(crate::model::style::SolidFill {
            background_color: effective_rgb,
            pattern_color: header.basic_attr.pattern_color,
            pattern_type: header.basic_attr.pattern_type as i32,
        }),
        gradient,
        image: None,
        // [Task #877 Stage 4] 한컴 호환 alpha convention: 0=불투명, 255=완전 투명.
        // (renderer/layout/utils.rs:199 의 opacity 식: opacity = 1 - alpha/255)
        // 기존 alpha=255 → opacity=0 → SVG <rect opacity="0.000"> 완전 투명 회귀.
        // HWP3 raw 에는 alpha 정보 없음, 한컴 viewer 의 default = 불투명 = alpha 0.
        alpha: 0,
    };

    let text_box = if (header.basic_attr.options & (1 << 19)) != 0 || !parsed_paragraphs.is_empty()
    {
        Some(TextBox {
            margin_left: hwp3_margin_to_i16(header.basic_attr.textbox_margin[0]),
            margin_top: hwp3_margin_to_i16(header.basic_attr.textbox_margin[1]),
            margin_right: hwp3_margin_to_i16(header.basic_attr.textbox_margin[0]),
            margin_bottom: hwp3_margin_to_i16(header.basic_attr.textbox_margin[1]),
            paragraphs: parsed_paragraphs,
            ..Default::default()
        })
    } else {
        None
    };

    let drawing_attr = DrawingObjAttr {
        shape_attr,
        border_line,
        fill,
        text_box,
        ..Default::default()
    };

    match final_shape {
        ShapeObject::Line(ref mut s) => {
            s.common = common;
            s.drawing = drawing_attr;
        }
        ShapeObject::Rectangle(ref mut s) => {
            s.common = common;
            s.drawing = drawing_attr;
        }
        ShapeObject::Ellipse(ref mut s) => {
            s.common = common;
            s.drawing = drawing_attr;
        }
        ShapeObject::Arc(ref mut s) => {
            s.common = common;
            s.drawing = drawing_attr;
        }
        ShapeObject::Polygon(ref mut s) => {
            s.common = common;
            s.drawing = drawing_attr;
        }
        ShapeObject::Curve(ref mut s) => {
            s.common = common;
            s.drawing = drawing_attr;
        }
        ShapeObject::Group(ref mut s) => {
            s.common = common;
            s.shape_attr = drawing_attr.shape_attr;
        }
        _ => {}
    }

    Ok((final_shape, connection_info))
}

// ─────────────────────────────────────────────────────────────────────────────
// [upstream 손이식] HWP3 그리기 개체 강건성 회귀 (6bcbadcd1·278d1b297)
// 판정: docs/upstream-이식-대장.md §3-2
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod drawing_robustness_tests {
    use super::*;
    use std::io::Cursor;

    // [POC] textbox_margin/line_width/object_size 는 파일에서 그대로 읽은 신뢰
    // 불가 u32 값이다. `* HWP3_UNIT_SCALE(4)` 를 i32/i16 로 계산·캐스팅하는
    // 과정에서 큰 값(예: u32::MAX)이 들어오면 곱셈이 i32 오버플로를 일으켜
    // debug 빌드에서 panic 한다(fuzzing/악성 파일 경로에서 서비스 거부).
    #[test]
    fn map_to_shape_object_does_not_panic_on_huge_margins() {
        let header = Hwp3DrawingObjectCommonHeader {
            object_type: 6, // TextBox
            object_size: [u32::MAX, u32::MAX],
            relative_pos: [u32::MAX, u32::MAX],
            basic_attr: Hwp3DrawingObjectBasicAttr {
                line_width: u32::MAX,
                textbox_margin: [u32::MAX, u32::MAX],
                ..Default::default()
            },
            ..Default::default()
        };
        let raw = Hwp3DrawingObject::TextBox(
            header,
            Hwp3DrawingTextBox {
                info1_len: 0,
                info2_len: 0,
                paragraph_list_data: Vec::new(),
            },
        );
        let mut doc_char_shapes = Vec::new();
        let mut doc_para_shapes = Vec::new();
        let mut doc_border_fills = Vec::new();
        let mut doc_tab_defs = Vec::new();
        let mut pic_name_to_id = HashMap::new();
        let result = map_to_shape_object(
            raw,
            &mut doc_char_shapes,
            &mut doc_para_shapes,
            &mut doc_border_fills,
            &mut doc_tab_defs,
            &mut pic_name_to_id,
        );
        assert!(
            result.is_ok(),
            "거대한 margin/width 값에서도 panic 없이 처리되어야 함"
        );
    }

    /// object_type=0(Container)에 connection_info=0x0002(has_child, no
    /// sibling)만 실은 최소 92바이트 공통 헤더를 만든다.
    fn container_block() -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0u32.to_le_bytes()); // header_length
        buf.extend_from_slice(&0u16.to_le_bytes()); // object_type = 0 (Container)
        buf.extend_from_slice(&0x0002u16.to_le_bytes()); // connection_info: has_child, !has_sibling
        buf.extend_from_slice(&[0u8; 8]); // relative_pos
        buf.extend_from_slice(&[0u8; 8]); // object_size
        buf.extend_from_slice(&[0u8; 8]); // absolute_pos
        buf.extend_from_slice(&[0u8; 16]); // bounds
        buf.extend_from_slice(&[0u8; 32]); // basic_attr: line_style..pattern_color
        buf.extend_from_slice(&[0u8; 8]); // basic_attr: textbox_margin
        buf.extend_from_slice(&0u32.to_le_bytes()); // basic_attr: options
        buf
    }

    // has_child 는 파일에서 그대로 온 값이라 재귀 깊이 상한이 없으면 Container
    // 객체를 깊이 중첩한 파일 하나로 네이티브 스택을 고갈시켜 프로세스를
    // 죽인다(catch_unwind 로 못 잡음). MAX_DRAWING_OBJECT_DEPTH 를 넘는 중첩이
    // 패닉/abort 대신 파싱 오류로 거부되는지 확인한다.
    #[test]
    fn deeply_nested_container_chain_is_rejected_not_stack_overflowed() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&24u32.to_le_bytes()); // frame header_length (<=24: 하이퍼텍스트 없음)
        buf.extend_from_slice(&0u32.to_le_bytes()); // z_order
        buf.extend_from_slice(&1u32.to_le_bytes()); // object_count
        buf.extend_from_slice(&[0u8; 16]); // bounds

        for _ in 0..(MAX_DRAWING_OBJECT_DEPTH as usize + 4) {
            buf.extend_from_slice(&container_block());
        }

        let mut doc_char_shapes = Vec::new();
        let mut doc_para_shapes = Vec::new();
        let mut doc_border_fills = Vec::new();
        let mut doc_tab_defs = Vec::new();
        let mut pic_name_to_id = HashMap::new();

        let mut cursor = Cursor::new(buf.as_slice());
        let result = parse_drawing_object_tree(
            &mut cursor,
            &mut doc_char_shapes,
            &mut doc_para_shapes,
            &mut doc_border_fills,
            &mut doc_tab_defs,
            &mut pic_name_to_id,
        );

        // 깊이 상한이 EOF 보다 먼저 발화해야 한다 — 오류 종류까지 단언해
        // "버퍼 소진으로 인한 IoError" 와 구분한다(우리 강화).
        match result {
            Err(Hwp3Error::ParseError { ref message }) if message.contains("nesting exceeds") => {}
            other => panic!(
                "상한을 넘는 중첩은 깊이 초과 ParseError 로 거부되어야 함: {:?}",
                other.map(|_| "Ok")
            ),
        }
    }
}
