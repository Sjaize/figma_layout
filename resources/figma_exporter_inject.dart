// resources/figma_exporter_inject.dart

import 'dart:convert';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

/// 1. 색상 변환 유틸리티 (Color -> Hex String)
String? _colorToHex(Color? color) {
  if (color == null) return null;
  return '#${color.value.toRadixString(16).padLeft(8, '0')}';
}

/// 2. 핵심 크롤러 로직
Map<String, dynamic>? _crawl(RenderObject? node) {
  // 화면에 보이지 않거나 크기가 없는 노드 제외
  if (node == null || node is! RenderBox || !node.hasSize) return null;
  if (node.size.width == 0 && node.size.height == 0) return null;

  // ✨ [NEW] 숨겨진 화면(Offstage) 필터링 추가
  // Navigator는 뒤에 있는 화면을 RenderOffstage로 감싸고 offstage=true로 설정합니다.
  if (node is RenderOffstage && node.offstage) {
    return null; // 무대 뒤에 있으니 크롤링 중단 (자식들도 안 봄)
  }

  // A. 화면 절대 좌표 계산
  Offset offset;
  try {
    offset = node.localToGlobal(Offset.zero);
  } catch (e) {
    return null; // 레이아웃이 완료되지 않은 경우
  }

  // B. 타입 및 속성 분석
  String type = 'Frame'; // 기본값
  Map<String, dynamic> props = {};
  bool hasVisualProperty = false; // 눈에 보이는 요소(색상, 글자, 그림)가 있는지 여부
  bool isLayoutNode = false; // Row, Column 등 구조적인 역할을 하는지 여부

  String runtimeType = node.runtimeType.toString();

  // --- [1] 텍스트 (Text) ---
  if (node is RenderParagraph) {
    type = 'Text';
    hasVisualProperty = true;
    try {
      props['content'] = node.text.toPlainText();
      props['textAlign'] = node.textAlign.toString();
      
      // 스타일 추출
      InlineSpan text = node.text;
      if (text is TextSpan && text.style != null) {
        final style = text.style!;
        props['fontFamily'] = style.fontFamily;
        props['fontSize'] = style.fontSize;
        props['fontWeight'] = style.fontWeight.toString();
        props['color'] = _colorToHex(style.color);
        props['letterSpacing'] = style.letterSpacing;
      }
    } catch (e) {}
  } 
  
  // --- [2] 이미지 (Image) ---
  else if (node is RenderImage) {
    type = 'Image';
    hasVisualProperty = true;
    try {
      props['imagePath'] = node.debugImageLabel; // 디버그 모드에서만 유효
      props['fit'] = 'cover'; // 기본값 추정
    } catch (e) {}
  } 
  
  // --- [3] 레이아웃 (Flex: Row/Column) ---
  else if (node is RenderFlex) {
    type = 'Frame';
    isLayoutNode = true; // Auto Layout 후보
    props['layoutMode'] = node.direction == Axis.horizontal ? 'HORIZONTAL' : 'VERTICAL';
    props['mainAxisAlignment'] = node.mainAxisAlignment.toString();
    props['crossAxisAlignment'] = node.crossAxisAlignment.toString();
    // Flex는 눈에 보이지 않지만 구조적으로 중요하므로 보존할 가치가 있음
  } 
  
  // --- [4] 디자인 박스 (Container, DecoratedBox) ---
  else if (node is RenderDecoratedBox) {
    type = 'Frame';
    try {
      final decoration = node.decoration;
      if (decoration is BoxDecoration) {
        // 배경색
        if (decoration.color != null) {
          props['backgroundColor'] = _colorToHex(decoration.color);
          hasVisualProperty = true;
        }
        // 테두리
        if (decoration.border != null) {
          props['hasBorder'] = true;
          hasVisualProperty = true;
        }
        // 라운드
        if (decoration.borderRadius != null) {
          props['borderRadius'] = decoration.borderRadius.toString();
        }
        // 그림자
        if (decoration.boxShadow != null && decoration.boxShadow!.isNotEmpty) {
           props['hasShadow'] = true;
           hasVisualProperty = true;
        }
      }
    } catch (e) {}
  }
  
  // --- [4.5] 물리적 모델 (Material 위젯, ElevatedButton 그림자/모양 등) ---
  else if (node is RenderPhysicalModel) {
    type = 'Frame';
    hasVisualProperty = true;
    try {
      props['backgroundColor'] = _colorToHex(node.color);
      
      if (node.elevation > 0) {
        props['hasShadow'] = true;
        props['elevation'] = node.elevation;
      }
      
      // PhysicalModel은 borderRadius를 직접 가질 때가 많음
      try {
        // 리플렉션 없이 dynamic으로 접근 시도
        dynamic dynamicNode = node;
        if (dynamicNode.borderRadius != null) {
           props['borderRadius'] = dynamicNode.borderRadius.toString();
        }
      } catch(e) {}
    } catch (e) {}
  } 
  // --- [4.6] 물리적 모양 (ElevatedButton 등) ---
  else if (node is RenderPhysicalShape) {
    type = 'Frame';
    hasVisualProperty = true;
    try {
      props['backgroundColor'] = _colorToHex(node.color);
      
      if (node.elevation > 0) {
        props['hasShadow'] = true;
        props['elevation'] = node.elevation;
      }
      
      // 🔥 [새로운 방식] clipper.shape 직접 접근
      try {
        print('\n🔥 [타겟 발견] RenderPhysicalShape 분석 시작');
        
        final diagnostics = node.toDiagnosticsNode();
        final properties = diagnostics.getProperties();
        
        // 1. clipper 속성 찾기
        final clipperProp = properties.firstWhere(
          (p) => p.name == 'clipper', 
          orElse: () => DiagnosticsProperty('dummy', null)
        );
        
        if (clipperProp.value != null) {
          // dynamic 타입을 사용해 강제로 객체로 취급
          dynamic clipper = clipperProp.value;
          print('   📦 Clipper 객체: ${clipper.runtimeType}');
          
          // 2. [핵심] Clipper 안의 'shape' 변수 꺼내기
          try {
            dynamic shape = clipper.shape;
            print('   ✅ [성공] clipper.shape 접근 성공!');
            
            String shapeString = shape.toString();
            print('   📝 Shape 내용: $shapeString');
            
            // 정규식으로 circular(48.0) 패턴 찾기
            RegExp radiusPattern = RegExp(r'circular\(([\d\.]+)\)');
            Match? match = radiusPattern.firstMatch(shapeString);
            
            if (match != null) {
              props['borderRadius'] = match.group(1);
              print('   ✅ 찾았다! Radius: ${match.group(1)}');
            } else {
              props['isCustomShape'] = true;
              print('   ❌ 못 찾음 (circular 패턴 없음)');
            }
          } catch (e) {
            props['isCustomShape'] = true;
            print('   ❌ [실패] shape 접근 불가: $e');
          }
        } else {
          props['isCustomShape'] = true;
          print('   ⚠️ Clipper가 null입니다.');
        }
        print('--------------------------------------------------\n');
      } catch (e) {
        props['isCustomShape'] = true;
        print('   ❌ 전체 에러: $e');
      }
    } catch (e) {
      // 에러 무시
    }
  }
  
  // --- [5] 벡터/아이콘 등 (기타) ---
  else if (runtimeType.contains('Picture') || runtimeType.contains('CustomPaint')) {
    // 자식이 있으면(예: 버튼 안의 텍스트) 단순 컨테이너(Frame)로 취급해야 함.
    // 자식이 없다면(예: 아이콘) 그래픽 요소(Vector)로 취급.
    // 전략: 일단 Frame으로 정의하되, 특별한 플래그를 심어줍니다.
    type = 'Frame'; 
    props['isVectorCandidate'] = true; 
    
    // CustomPaint는 그 자체로 시각적 요소(물결 효과 등)를 가질 수 있으므로 true 유지
    hasVisualProperty = true;
  }

  // C. 자식 순회 (Recursion)
  List<Map<String, dynamic>> children = [];
  try {
    node.visitChildren((child) {
      var result = _crawl(child as RenderObject?);
      if (result != null) {
        children.add(result);
      }
    });
  } catch (e) {}

  // ============================================================
  // 🔥 [Smart Flattening] 불필요한 껍데기 제거
  // ============================================================
  
  // 조건:
  // 1. 기본 Frame이고 (Text/Image/Vector 아님)
  // 2. 시각적 속성(배경색 등)이 없고
  // 3. Auto Layout(Flex) 같은 중요한 구조적 역할도 없으며
  // 4. 자식이 딱 하나만 있을 때
  if (type == 'Frame' && 
      !hasVisualProperty && 
      !isLayoutNode && 
      children.length == 1) {
        
    final child = children.first;
    
    // 자식만 위로 올림 (현재 노드는 JSON 트리에서 사라짐)
    // 단, 자식의 좌표(rect)는 이미 Global 좌표로 계산되어 있으므로 그대로 쓰면 됨.
    // (상대 좌표였다면 부모 offset을 더해줘야 했겠지만, 우리는 localToGlobal을 썼음)
    return child;
  }

  // 예외 처리: 자식이 없는데 시각적 속성도 없는 빈 Frame은 제거 (단, 크기가 있는 공간 차지는 제외)
  // 너비와 높이가 "모두" 작을 때만 제거 (&& 연산자)
  // SizedBox(width: 0, height: 200) 같은 '공백'을 살리기 위함
  if (children.isEmpty && !hasVisualProperty && (node.size.width < 1 && node.size.height < 1)) {
    return null;
  }

  // D. 최종 노드 반환
  return {
    'type': type,
    'rect': {
      'x': offset.dx,
      'y': offset.dy,
      'w': node.size.width,
      'h': node.size.height
    },
    'properties': props,
    'children': children
  };
}

/// 외부 호출용 진입점
String figmaExtractorEntryPoint() {
  try {
    final binding = RendererBinding.instance;
    if (binding == null) return jsonEncode({'error': 'Binding is null'});
    
    final root = binding.renderView;
    if (root == null) return jsonEncode({'error': 'Root view is null'});
    
    // 루트부터 크롤링 시작
    // RenderView는 자식들을 직접 방문해야 함
    List<Map<String, dynamic>> rootChildren = [];
    root.visitChildren((child) {
      final res = _crawl(child);
      if (res != null) rootChildren.add(res);
    });

    // 전체를 감싸는 최상위 Frame 생성
    double maxWidth = 0.0;
    double maxHeight = 0.0;
    
    // 자식들의 크기로 전체 캔버스 크기 추정
    try {
      maxWidth = root.size.width;
      maxHeight = root.size.height;
    } catch (e) {
      // 사이즈 접근 실패 시 기본값 사용
    }

    final data = {
      'type': 'Frame',
      'name': 'Flutter Screen',
      'rect': {
        'x': 0.0,
        'y': 0.0,
        'w': maxWidth > 0 ? maxWidth : 390.0,
        'h': maxHeight > 0 ? maxHeight : 844.0,
      },
      'properties': {'backgroundColor': '#ffffffff'}, // 기본 흰 배경
      'children': rootChildren,
    };
    
    return jsonEncode(data);
  } catch (e, stack) {
    return jsonEncode({
      'error': e.toString(),
      'stackTrace': stack.toString()
    });
  }
}
