import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';
import { sleep, countNodes } from './utils';
import { sendRequest, setWebSocket, setupMessageHandler } from './vmService';
import { runFlutterAndGetVmServiceUri } from './flutterRunner';
import { injectFigmaCrawlerViaHotReload } from './hotReloadInject';

let output: vscode.OutputChannel;

/**
 * Dump Figma Layout 초기화
 */
export function initDumpFigmaLayout(outputChannel: vscode.OutputChannel) {
  output = outputChannel;
}

/**
 * 이미지를 Base64로 변환하여 JSON에 임베딩하는 함수 (재귀)
 */
function embedImagesInJson(node: any, projectRoot: string) {
  if (node.type === 'Image' && node.properties?.imagePath) {
    try {
      // ---------------------------------------------------------
      // 🚨 [Critical Fix] 경로 파싱 개선
      // Flutter가 주는 문자열: 'AssetImage(name: "assets/logo.png")'
      // 우리가 필요한 문자열: 'assets/logo.png'
      // ---------------------------------------------------------
      let rawPath = node.properties.imagePath;
      
      // 1. 따옴표 안에 있는 경로만 추출 (정규식)
      // 예: "assets/logo.png" 또는 'assets/logo.png' 추출
      const match = rawPath.match(/["']([^"']+)["']/);
      if (match && match[1]) {
        rawPath = match[1]; 
      } else {
        // 따옴표가 없으면? (예: FileImage("/path/to/file"))
        // 괄호 안의 내용을 시도하거나, 그냥 원본 사용
        // 여기서는 간단히 'AssetImage(...)' 같은 껍데기만 제거 시도
        rawPath = rawPath.replace(/^.*Image\(.*name:\s*/, '').replace(/\)$/, '');
      }

      // 경로 정규화 (Windows/Mac 호환)
      const relativePath = path.normalize(rawPath);
      const fullPath = path.join(projectRoot, relativePath);

      if (fs.existsSync(fullPath)) {
        const stats = fs.statSync(fullPath);
        
        if (stats.size > 5 * 1024 * 1024) {
          output.appendLine(`[WARN] 이미지가 너무 큽니다 (${relativePath}). 전송 제외.`);
          node.properties.error = "Image too large (>5MB)";
        } else {
          const bitmap = fs.readFileSync(fullPath);
          node.properties.imageBase64 = bitmap.toString('base64');
          // 디버깅을 위해 실제 사용된 경로를 로그로 남김
          output.appendLine(`[Image] 변환 성공: ${relativePath}`);
        }
      } else {
        output.appendLine(`[WARN] 파일을 찾을 수 없습니다 (원본: ${node.properties.imagePath}) -> 시도한 경로: ${fullPath}`);
        node.properties.error = "Image file not found";
      }
    } catch (e: any) {
      output.appendLine(`[ERROR] 이미지 처리 중 오류: ${e.message}`);
    }
  }

  // 자식 재귀
  if (node.children && Array.isArray(node.children)) {
    node.children.forEach((child: any) => embedImagesInJson(child, projectRoot));
  }
}

/**
 * 새로운 방식: Figma 최적화 크롤러 (Hot Reload 방식)
 */
export async function dumpFigmaLayout(context: vscode.ExtensionContext) {
  let cleanup: (() => void) | undefined;
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage('워크스페이스 폴더가 없습니다.');
      return;
    }
    const projectPath = folders[0].uri.fsPath;
    output.appendLine(`[Hot Reload] Project path: ${projectPath}`);

    // VM Service URI 확인 (실행 중인 디버그 세션 또는 수동 입력)
    let vmServiceUri: string | undefined;
    
    // 1. 실행 중인 Flutter 디버그 세션 확인
    const debugSession = vscode.debug.activeDebugSession;
    if (debugSession && debugSession.type === 'dart') {
      // 디버그 세션이 있으면 VM Service URI 추출 시도
      try {
        const vmService = await debugSession.customRequest('getVM');
        // VM Service URI는 직접 제공되지 않으므로, WebSocket URI를 구성해야 함
        // 실제로는 debugSession.customRequest를 통해 접근해야 할 수도 있음
        output.appendLine(`[Hot Reload] 실행 중인 디버그 세션 발견: ${debugSession.id}`);
      } catch (e) {
        output.appendLine(`[Hot Reload] 디버그 세션에서 VM Service URI 추출 실패: ${e}`);
      }
    }

    // 2. 수동 입력 또는 자동 실행
    if (!vmServiceUri) {
      const manualUri = await vscode.window.showInputBox({
        title: 'Flutter VM Service URI 입력 (비우면 자동 실행)',
        prompt:
          '이미 실행 중인 앱의 VM Service URI (예: ws://127.0.0.1:8181/ws). 비우면 flutter run --machine 으로 자동 실행합니다.',
        placeHolder: 'ws://127.0.0.1:8181/ws',
        ignoreFocusOut: true,
        value: '',
      });

      if (manualUri && manualUri.trim().length > 0) {
        vmServiceUri = manualUri.trim();
        output.appendLine(`[Hot Reload] [Manual] Using VM Service: ${vmServiceUri}`);
        
        // 수동 URI인 경우에도 코드 주입 및 Hot Reload 필요
        output.appendLine(`[Hot Reload] 코드 주입 중...`);
        const injection = injectFigmaCrawlerViaHotReload(projectPath, context);
        cleanup = injection.cleanup;
      } else {
        // 자동 실행: 먼저 코드 주입, 그 다음 flutter run
        output.appendLine(`[Hot Reload] 코드 주입 중...`);
        const injection = injectFigmaCrawlerViaHotReload(projectPath, context);
        cleanup = injection.cleanup;

        output.appendLine(`[Hot Reload] Flutter 앱 실행 중...`);
        const result = await runFlutterAndGetVmServiceUri(projectPath);
        vmServiceUri = result.wsUri;
        output.appendLine(`[Hot Reload] [Auto] VM Service from flutter run: ${vmServiceUri}`);
      }
    } else {
      // 디버그 세션에서 URI를 얻은 경우에도 코드 주입 필요
      output.appendLine(`[Hot Reload] 코드 주입 중...`);
      const injection = injectFigmaCrawlerViaHotReload(projectPath, context);
      cleanup = injection.cleanup;
    }

    // 덤프 저장 디렉토리
    const dumpDir = path.join(projectPath, 'flutter_figma_dump');
    if (!fs.existsSync(dumpDir)) {
      fs.mkdirSync(dumpDir, { recursive: true });
    }

    // 3. Hot Reload 실행 (코드 주입이 이미 되어 있으면)
    // cleanup이 정의되어 있으면 코드가 주입된 것이므로 Hot Reload 필요
    if (cleanup !== undefined) {
      output.appendLine(`[Hot Reload] Hot Reload 실행 중...`);
      try {
        await vscode.commands.executeCommand('flutter.hotReload');
        await sleep(2000); // Hot Reload 완료 대기 (시간 증가)
        output.appendLine(`[Hot Reload] Hot Reload 완료`);
      } catch (e: any) {
        output.appendLine(`[Hot Reload] Hot Reload 실패 (무시 가능): ${e.message}`);
      }
    }

    // 4. VM Service 접속 & evaluate로 함수 호출
    await dumpFigmaLayoutFromVm(vmServiceUri, dumpDir, projectPath);

    vscode.window.showInformationMessage(
      `Figma 데이터가 클립보드에 복사되었습니다! (이미지 포함)`,
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    vscode.window.showErrorMessage(`Figma layout dump failed: ${msg}`);
    output.appendLine(`[Hot Reload ERROR] ${msg}`);
    if (err?.stack) output.appendLine(String(err.stack));
  } finally {
    // 파일 복구
    if (cleanup) {
      cleanup();
    }
  }
}

async function dumpFigmaLayoutFromVm(
  vmServiceUri: string,
  dumpDir: string,
  projectPath: string,
): Promise<void> {
  const ws = new WebSocket(vmServiceUri);
  setWebSocket(ws);

  return new Promise((resolve, reject) => {
    ws.on('error', (err) => reject(err));

    setupMessageHandler(() => {
      // 일반 메시지는 무시
    });

    ws.on('open', async () => {
      try {
        const vm = await sendRequest('getVM');
        const isolates = vm.isolates as Array<{ id: string; name: string }>;
        if (!isolates || isolates.length === 0) {
          throw new Error('VM에 isolates가 없습니다.');
        }
        const isolateId = isolates[0].id;
        output.appendLine(`[Hot Reload] isolate: ${isolateId}`);

        // 라이브러리 찾기: figma_temp_crawler.dart
        output.appendLine('[Hot Reload] figma_temp_crawler 라이브러리 찾는 중...');
        const isolate = await sendRequest('getIsolate', { isolateId });
        const libraries = isolate.libraries as Array<{ id: string; uri: string }>;
        
        // 여러 패턴으로 라이브러리 찾기 시도
        let crawlerLib = libraries.find(
          (lib) => lib.uri.includes('figma_temp_crawler.dart'),
        );
        
        // 대체 패턴: 파일명만 포함하는 경우
        if (!crawlerLib) {
          crawlerLib = libraries.find(
            (lib) => lib.uri.endsWith('figma_temp_crawler.dart') || lib.uri.includes('figma_temp_crawler'),
          );
        }
        
        // 디버깅: 모든 라이브러리 URI 출력
        if (!crawlerLib) {
          output.appendLine('[Hot Reload] 사용 가능한 라이브러리 목록:');
          libraries.slice(0, 10).forEach((lib) => {
            output.appendLine(`  - ${lib.uri}`);
          });
          if (libraries.length > 10) {
            output.appendLine(`  ... 외 ${libraries.length - 10}개`);
          }
        }

        if (crawlerLib) {
          output.appendLine(
            `[Hot Reload] 라이브러리 찾음: ${crawlerLib.uri} (${crawlerLib.id})`,
          );
        } else {
          // 라이브러리를 찾지 못해도 전역에서 시도
          output.appendLine('[Hot Reload] 경고: figma_temp_crawler 라이브러리를 찾지 못했습니다. 전역 컨텍스트에서 시도합니다.');
        }

        // 추가 대기 시간 (Hot Reload 완료 및 앱 렌더링 보장)
        await sleep(1500);

        // evaluate API로 figmaExtractorEntryPoint() 함수 호출
        output.appendLine('[Hot Reload] evaluate로 figmaExtractorEntryPoint() 호출 중...');
        let result;
        
        if (crawlerLib) {
          output.appendLine(
            `[Hot Reload] 라이브러리 찾음: ${crawlerLib.uri} (${crawlerLib.id})`,
          );
          try {
            // 먼저 라이브러리 컨텍스트에서 시도
            result = await sendRequest('evaluate', {
              isolateId,
              targetId: crawlerLib.id, // 라이브러리 컨텍스트 지정
              expression: 'figmaExtractorEntryPoint()',
            });
          } catch (e: any) {
            output.appendLine(
              `[Hot Reload] 라이브러리 컨텍스트 실패, 전역에서 시도: ${e.message}`,
            );
            // 전역 컨텍스트에서 시도
            result = await sendRequest('evaluate', {
              isolateId,
              expression: 'figmaExtractorEntryPoint()',
            });
          }
        } else {
          // 라이브러리를 찾지 못한 경우 전역에서 시도
          output.appendLine('[Hot Reload] 전역 컨텍스트에서 함수 호출 시도...');
          try {
            result = await sendRequest('evaluate', {
              isolateId,
              expression: 'figmaExtractorEntryPoint()',
            });
          } catch (e: any) {
            throw new Error(
              `함수를 찾을 수 없습니다. Hot Reload가 완료되었는지 확인하세요: ${e.message}`,
            );
          }
        }

        // 결과 파싱 (JSON 문자열 반환)
        let jsonString: string;
        if (result && typeof result === 'object') {
          // valueAsString이 있고 잘리지 않았으면 사용
          if (result.valueAsString && result.valueAsStringIsTruncated !== true) {
            jsonString = result.valueAsString;
          } else if (result.id) {
            // 값이 잘렸거나(truncated) valueAsString이 없는 경우, getObject로 전체 가져오기
            output.appendLine(`[Hot Reload] 결과가 잘려있어 전체 객체를 요청합니다... (ID: ${result.id})`);
            
            // 1. getObject로 Instance 가져오기
            const fullObject = await sendRequest('getObject', {
              isolateId,
              objectId: result.id,
            });

            if (fullObject && fullObject.valueAsString) {
              // Instance에서도 잘려있을 수 있음
              if (fullObject.valueAsStringIsTruncated === true) {
                output.appendLine('[Hot Reload] 전체 객체에서도 문자열이 잘려있습니다. 부분적으로 가져옵니다...');
                jsonString = fullObject.valueAsString;
                output.appendLine(`[Hot Reload] 경고: 가져온 문자열이 여전히 잘려있을 수 있습니다. 길이: ${jsonString.length}`);
              } else {
                jsonString = fullObject.valueAsString;
              }
            } else {
               // 에러 처리: String Instance가 아닐 수 있음
               throw new Error('전체 객체에서 문자열 값을 찾을 수 없습니다: ' + JSON.stringify(fullObject));
            }
          } else {
            throw new Error('예상치 못한 결과 형식 (ID 없음): ' + JSON.stringify(result));
          }
        } else if (typeof result === 'string') {
          jsonString = result;
        } else {
          throw new Error('예상치 못한 결과 형식: ' + JSON.stringify(result));
        }

        // JSON 문자열 길이 확인 및 로그
        output.appendLine(`[Hot Reload] JSON 문자열 길이: ${jsonString.length} 문자`);
        
        // JSON을 파일로 저장 (파싱 실패해도 원본 보존)
        const rawJsonPath = path.join(dumpDir, 'figma_layout_raw.json');
        fs.writeFileSync(rawJsonPath, jsonString, 'utf-8');
        output.appendLine(`[Hot Reload] 원본 JSON 저장: ${rawJsonPath}`);

        // JSON 파싱
        let figmaData: any;
        try {
          figmaData = JSON.parse(jsonString);
        } catch (e: any) {
          // JSON 파싱 실패 시 상세 정보를 파일로 저장
          const errorLogPath = path.join(dumpDir, 'error_log.txt');
          let errorLog = `JSON 파싱 오류 발생\n`;
          errorLog += `오류 메시지: ${e.message}\n`;
          errorLog += `JSON 길이: ${jsonString.length} 문자\n\n`;
          
          const errorPosition = e.message.match(/position (\d+)/);
          if (errorPosition) {
            const pos = parseInt(errorPosition[1]);
            const start = Math.max(0, pos - 200);
            const end = Math.min(jsonString.length, pos + 200);
            errorLog += `오류 위치: ${pos}\n`;
            errorLog += `오류 주변 텍스트 (${start}-${end}):\n${jsonString.substring(start, end)}\n\n`;
          }
          
          errorLog += `JSON 처음 1000자:\n${jsonString.substring(0, 1000)}\n\n`;
          if (jsonString.length > 1000) {
            errorLog += `JSON 마지막 1000자:\n${jsonString.substring(jsonString.length - 1000)}\n`;
          }
          
          fs.writeFileSync(errorLogPath, errorLog, 'utf-8');
          
          const errorMsg = `JSON 파싱 실패: ${e.message}\n\n` +
            `원본 JSON이 저장되었습니다: ${rawJsonPath}\n` +
            `오류 상세 로그: ${errorLogPath}\n\n` +
            `JSON 길이: ${jsonString.length} 문자\n` +
            `처음 500자: ${jsonString.substring(0, 500)}...`;
          
          output.appendLine(`[Hot Reload ERROR] ${errorMsg}`);
          throw new Error(errorMsg);
        }

        // 에러 체크
        if (figmaData.error) {
          const errorMsg = figmaData.error;
          const debugInfo = figmaData.debug ? `\n디버그 정보: ${figmaData.debug}` : '';
          const hint = figmaData.hint ? `\n힌트: ${figmaData.hint}` : '';
          const stackTrace = figmaData.stackTrace ? `\n\n스택 트레이스:\n${figmaData.stackTrace}` : '';
          throw new Error(`${errorMsg}${debugInfo}${hint}${stackTrace}`);
        }

        // 이미지 임베딩 (이미지 파일을 Base64로 변환해 넣기)
        output.appendLine('[Process] 이미지 에셋을 Base64로 변환 중...');
        embedImagesInJson(figmaData, projectPath);

        // 다시 문자열로 변환 (이미지 포함)
        const finalJsonString = JSON.stringify(figmaData, null, 2);

        // 파일 저장
        const figmaPath = path.join(dumpDir, 'figma_layout.json');
        fs.writeFileSync(
          figmaPath,
          finalJsonString,
          'utf-8',
        );
        output.appendLine(`[Hot Reload] figma_layout.json 저장: ${figmaPath}`);

        // 클립보드에 복사!
        await vscode.env.clipboard.writeText(finalJsonString);
        output.appendLine('[Process] 클립보드에 복사 완료');
        
        // 성공 로그도 파일로 저장
        const successLogPath = path.join(dumpDir, 'success_log.txt');
        const successLog = `Figma Layout 추출 성공!\n\n` +
          `추출 시간: ${new Date().toISOString()}\n` +
          `JSON 길이: ${jsonString.length} 문자\n` +
          `노드 개수: ${countNodes(figmaData)}개\n\n` +
          `생성된 파일:\n` +
          `- ${figmaPath}\n` +
          `- ${rawJsonPath}\n`;
        fs.writeFileSync(successLogPath, successLog, 'utf-8');

        // 통계 정보
        const nodeCount = countNodes(figmaData);
        output.appendLine(
          `[Hot Reload] 총 ${nodeCount}개 노드 추출 완료`,
        );

        ws.close();
        resolve();
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        output.appendLine(`[Hot Reload ERROR] ${msg}`);
        
        // 오류 상세 정보
        if (err.data) {
          const errorDetails = JSON.stringify(err.data, null, 2);
          output.appendLine(`[Hot Reload ERROR] 상세 오류 데이터:\n${errorDetails}`);
          const detailedError = new Error(`${msg}\n\n상세 정보:\n${errorDetails}`);
          reject(detailedError);
        } else {
          reject(err);
        }
      }
    });
  });
}

