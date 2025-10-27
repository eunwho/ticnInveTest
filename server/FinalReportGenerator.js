import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ES Module 환경에서 __dirname 사용을 위한 설정
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 제품 입력 정보를 파일에서 읽어오는 함수
 * @returns {Object} 제품 입력 정보 (modelName, productNames)
 */
function loadProductInput() {
  try {
    const productInputPath = path.join(__dirname, 'product_input.json');
    if (fs.existsSync(productInputPath)) {
      const data = fs.readFileSync(productInputPath, 'utf-8');
      const productInput = JSON.parse(data);
      console.log(`[FinalReportGenerator] Product input loaded: ${JSON.stringify(productInput)}`);
      return productInput;
    }
  } catch (error) {
    console.warn(`[FinalReportGenerator] Failed to load product input: ${error.message}`);
  }
  
  // 기본값
  const defaultProductInput = {
    modelName: 'Unknown Model',
    productNames: ['A-001', 'B-002', 'C-003']
  };
  console.log(`[FinalReportGenerator] Using default product input: ${JSON.stringify(defaultProductInput)}`);
  return defaultProductInput;
}

/**
 * 디바이스 선택 상태를 파일에서 읽어오는 함수
 * @returns {Array} 선택된 디바이스 상태 배열 (10개 요소, true/false)
 */
function loadDeviceStates() {
  try {
    const deviceStatesPath = path.join(__dirname, 'device_states.json');
    if (fs.existsSync(deviceStatesPath)) {
      const data = fs.readFileSync(deviceStatesPath, 'utf-8');
      const deviceStates = JSON.parse(data);
      
      // 배열 형태로 저장된 경우
      if (Array.isArray(deviceStates) && deviceStates.length === 10) {
        console.log(`[FinalReportGenerator] Device states loaded: ${JSON.stringify(deviceStates)}`);
        return deviceStates;
      }
      // 기존 객체 형태로 저장된 경우 (마이그레이션)
      else if (typeof deviceStates === 'object' && deviceStates !== null) {
        console.log(`[FinalReportGenerator] Migrating from object format to array format`);
        const expectedDevices = [
          "#1 Device", "#2 Device", "#3 Device", "#4 Device", "#5 Device",
          "#6 Device", "#7 Device", "#8 Device", "#9 Device", "#10 Device"
        ];
        const arrayFormat = expectedDevices.map(device => deviceStates[device] || false);
        console.log(`[FinalReportGenerator] Migrated device states: ${JSON.stringify(arrayFormat)}`);
        return arrayFormat;
      }
    }
  } catch (error) {
    console.warn(`[FinalReportGenerator] Failed to load device states: ${error.message}`);
  }
  
  // 기본값: 10개 요소 배열 (첫 번째 기기만 선택된 상태)
  const defaultStates = [true, false, false, false, false, false, false, false, false, false];
  console.log(`[FinalReportGenerator] Using default device states: ${JSON.stringify(defaultStates)}`);
  return defaultStates;
}

/**
 * 고온 설정을 파일에서 읽어오는 함수
 * @returns {Object} 고온 설정 정보
 */
function loadHighTempSettings() {
  try {
    const settingsPath = path.join(__dirname, 'high_temp_settings.json');
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(data);
      console.log(`[FinalReportGenerator] High temp settings loaded: ${JSON.stringify(settings)}`);
      return settings;
    }
  } catch (error) {
    console.warn(`[FinalReportGenerator] Failed to load high temp settings: ${error.message}`);
  }
  
  // 기본값
  const defaultSettings = {
    highTemp: false,
    targetTemp: 75,
    waitTime: 200,
    readCount: 10
  };
  console.log(`[FinalReportGenerator] Using default high temp settings: ${JSON.stringify(defaultSettings)}`);
  return defaultSettings;
}

/**
 * 저온 설정을 파일에서 읽어오는 함수
 * @returns {Object} 저온 설정 정보
 */
function loadLowTempSettings() {
  try {
    const settingsPath = path.join(__dirname, 'low_temp_settings.json');
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(data);
      console.log(`[FinalReportGenerator] Low temp settings loaded: ${JSON.stringify(settings)}`);
      return settings;
    }
  } catch (error) {
    console.warn(`[FinalReportGenerator] Failed to load low temp settings: ${error.message}`);
  }
  
  // 기본값
  const defaultSettings = {
    lowTemp: false,
    targetTemp: -32,
    waitTime: 200,
    readCount: 10
  };
  console.log(`[FinalReportGenerator] Using default low temp settings: ${JSON.stringify(defaultSettings)}`);
  return defaultSettings;
}

/**
 * 현재 날짜와 시간을 포맷된 문자열로 반환
 * @returns {string} YYYY-MM-DD HH:mm:ss 형식의 날짜시간 문자열
 */
function getFormattedDateTime() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 파일명에 사용할 안전한 타임스탬프 생성
 * @returns {string} 파일명에 안전한 타임스탬프 문자열
 */
function getSafeTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

/**
 * 지정된 디렉토리에서 전압측정 CSV 파일들을 검색하고 분석하여 최종보고서 생성
 * @param {string} directoryPath - 분석할 디렉토리 경로
 * @param {string} directoryName - 디렉토리 이름 (파일명에 사용)
 * @returns {Object} 최종보고서 생성 결과
 */
export async function generateFinalReportFromDirectory(directoryPath, directoryName = null) {
  try {
    console.log(`[FinalReportGenerator] 최종보고서 생성 시작 - 디렉토리: ${directoryPath}`);
    
    // 디렉토리 존재 확인
    if (!fs.existsSync(directoryPath)) {
      throw new Error(`디렉토리가 존재하지 않습니다: ${directoryPath}`);
    }
    
    // 디바이스 선택 상태 로드
    const deviceStates = loadDeviceStates();
    console.log(`[FinalReportGenerator] 로드된 디바이스 선택 상태: ${JSON.stringify(deviceStates)}`);
    
    // 제품 입력 정보 로드
    const productInput = loadProductInput();
    console.log(`[FinalReportGenerator] 로드된 제품 입력 정보: ${JSON.stringify(productInput)}`);
    
    // CSV 파일 검색
    const csvFiles = scanCSVFilesInDirectory(directoryPath);
    console.log(`[FinalReportGenerator] 발견된 CSV 파일: ${csvFiles.length}개`);
    
    if (csvFiles.length === 0) {
      throw new Error('전압측정 CSV 파일이 없습니다.');
    }
    
    // CSV 파일들 분석 (디바이스 선택 상태 포함)
    const deviceResults = analyzeCSVFiles(csvFiles, directoryPath, deviceStates, productInput);
    console.log(`[FinalReportGenerator] 분석된 디바이스: ${Object.keys(deviceResults).length}개`);
    
    // 최종 결론 생성 (디바이스 선택 상태 포함)
    const finalConclusions = generateFinalConclusions(deviceResults, deviceStates);
    
    // 보고서 파일 생성
    const reportResult = await createFinalReportFile(finalConclusions, directoryPath, directoryName, deviceStates, productInput);
    
    console.log(`[FinalReportGenerator] 최종보고서 생성 완료: ${reportResult.filename}`);
    
    return {
      success: true,
      ...reportResult,
      deviceResults: finalConclusions,
      analyzedFiles: csvFiles.length,
      deviceStates: deviceStates
    };
    
  } catch (error) {
    console.error('[FinalReportGenerator] 최종보고서 생성 실패:', error);
    return { 
      success: false, 
      error: error.message,
      directoryPath,
      directoryName 
    };
  }
}

/**
 * 디렉토리에서 전압측정 CSV 파일들을 검색
 * @param {string} directoryPath - 검색할 디렉토리 경로
 * @returns {Array} 발견된 CSV 파일 목록
 */
function scanCSVFilesInDirectory(directoryPath) {
  const csvFiles = [];
  
  try {
    const files = fs.readdirSync(directoryPath);
    
    for (const file of files) {
      const filePath = path.join(directoryPath, file);
      const stat = fs.statSync(filePath);
      
      // 파일이고 CSV 확장자인 경우
      if (stat.isFile() && file.toLowerCase().endsWith('.csv')) {
        // 전압측정 파일인지 확인 (파일명에 특정 패턴이 있는지 확인)
        if (isVoltageMeasurementFile(file)) {
          csvFiles.push({
            filename: file,
            filepath: filePath,
            size: stat.size,
            modified: stat.mtime
          });
        }
      }
    }
    
    // 수정일시 기준으로 정렬 (최신순)
    csvFiles.sort((a, b) => b.modified - a.modified);
    
  } catch (error) {
    console.error('[FinalReportGenerator] CSV 파일 검색 실패:', error);
  }
  
  return csvFiles;
}

/**
 * 파일명이 전압측정 파일인지 확인
 * @param {string} filename - 파일명
 * @returns {boolean} 전압측정 파일 여부
 */
function isVoltageMeasurementFile(filename) {
  const lowerFilename = filename.toLowerCase();
  
  // 제외할 파일들 (최종보고서 등)
  const excludeKeywords = [
    'final',
    'report',
    'summary',
    'conclusion'
  ];
  
  // 제외 키워드가 포함된 경우 false
  for (const exclude of excludeKeywords) {
    if (lowerFilename.includes(exclude)) {
      return false;
    }
  }
  
  // 전압측정 관련 키워드가 포함된 파일들 (더 구체적으로)
  const voltageKeywords = [
    'cycle',
    'hightemp',
    'lowtemp',
    'timemode',
    'test',
    'voltage',
    'volt',
    'measurement'
  ];
  
  // 포함 키워드가 있는 경우 true
  for (const keyword of voltageKeywords) {
    if (lowerFilename.includes(keyword)) {
      return true;
    }
  }
  
  // 키워드가 없어도 CSV 파일이면 전압측정 파일로 간주 (기본값)
  return true;
}

/**
 * CSV 파일들을 분석하여 디바이스별 결과 생성 (상세한 전압 테이블 데이터 포함)
 * @param {Array} csvFiles - 분석할 CSV 파일 목록
 * @param {string} directoryPath - 디렉토리 경로
 * @param {Array} deviceStates - 디바이스 선택 상태 배열
 * @param {Object} productInput - 제품 입력 정보
 * @returns {Object} 디바이스별 분석 결과
 */
function analyzeCSVFiles(csvFiles, directoryPath, deviceStates, productInput) {
  // 3개 디바이스, 1개 채널 구조로 초기화 (상세한 측정 데이터 포함)
  const deviceResults = {
    'Device 1': {
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      measurements: {}, // 상세한 측정 데이터 저장
      channels: {
        'Channel 1': { totalTests: 0, passedTests: 0, failedTests: 0 }
      }
    },
    'Device 2': {
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      measurements: {},
      channels: {
        'Channel 1': { totalTests: 0, passedTests: 0, failedTests: 0 }
      }
    },
    'Device 3': {
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      measurements: {},
      channels: {
        'Channel 1': { totalTests: 0, passedTests: 0, failedTests: 0 }
      }
    }
  };
  
  for (const csvFile of csvFiles) {
    try {
      console.log(`[FinalReportGenerator] CSV 파일 분석 중: ${csvFile.filename}`);
      
      const fileContent = fs.readFileSync(csvFile.filepath, 'utf8');
      const lines = fileContent.split('\n').filter(line => line.trim());
      
      if (lines.length < 2) {
        console.warn(`[FinalReportGenerator] 파일이 너무 짧음: ${csvFile.filename}`);
        continue;
      }
      
      // 헤더 라인 분석
      const headerLine = lines[0];
      const dataLines = lines.slice(1);
      
      // 디바이스 정보 추출 (상세한 측정 데이터 포함)
      const deviceInfo = extractDeviceInfoFromCSV(headerLine, dataLines, csvFile.filename, deviceStates, productInput);
      
      if (deviceInfo && deviceInfo.deviceData) {
        // 3개 디바이스별 결과 분석 (선택된 디바이스만)
        for (const [deviceName, deviceData] of Object.entries(deviceInfo.deviceData)) {
          if (deviceResults[deviceName]) {
            // 디바이스 선택 상태 확인 (Device 1 = index 0, Device 2 = index 1, Device 3 = index 2)
            const deviceIndex = parseInt(deviceName.split(' ')[1]) - 1; // Device 1 -> index 0
            const isDeviceSelected = deviceStates[deviceIndex];
            
            if (isDeviceSelected) {
              // 선택된 디바이스만 실제 데이터 처리 (파일별 결과 포함)
              if (deviceData.measurements) {
                for (const [voltage, measurementData] of Object.entries(deviceData.measurements)) {
                  if (!deviceResults[deviceName].measurements[voltage]) {
                    deviceResults[deviceName].measurements[voltage] = {
                      ...measurementData,
                      totalTests: 0,
                      passedTests: 0,
                      failedTests: 0,
                      fileResults: {} // 파일별 결과를 저장할 객체
                    };
                  }
                  
                  // 파일별 결과 저장
                  if (!deviceResults[deviceName].measurements[voltage].fileResults) {
                    deviceResults[deviceName].measurements[voltage].fileResults = {};
                  }
                  
                  // 현재 파일의 결과를 파일별 결과에 저장
                  deviceResults[deviceName].measurements[voltage].fileResults[csvFile.filename] = {
                    aql: measurementData.aql,
                    measurements: measurementData.measurements,
                    totalTests: measurementData.totalTests || 0,
                    passedTests: measurementData.passedTests || 0,
                    failedTests: measurementData.failedTests || 0
                  };
                  
                  // 전압별 통계 누적 (파일들이 여러 개일 수 있으므로)
                  deviceResults[deviceName].measurements[voltage].totalTests += (measurementData.totalTests || 0);
                  deviceResults[deviceName].measurements[voltage].passedTests += (measurementData.passedTests || 0);
                  deviceResults[deviceName].measurements[voltage].failedTests += (measurementData.failedTests || 0);
                }
              }
              
              // 통계 업데이트
              deviceResults[deviceName].totalTests += deviceData.totalTests;
              deviceResults[deviceName].passedTests += deviceData.passedTests;
              deviceResults[deviceName].failedTests += deviceData.failedTests;
              deviceResults[deviceName].channels['Channel 1'].totalTests += deviceData.totalTests;
              deviceResults[deviceName].channels['Channel 1'].passedTests += deviceData.passedTests;
              deviceResults[deviceName].channels['Channel 1'].failedTests += deviceData.failedTests;
              
              console.log(`[FinalReportGenerator] ${deviceName} Channel 1: ${deviceData.totalTests}개 테스트 - 업데이트 완료 (선택됨)`);
            } else {
              // 선택되지 않은 디바이스는 기본값으로 설정
              deviceResults[deviceName].isSelected = false;
              console.log(`[FinalReportGenerator] ${deviceName} - 선택되지 않음, 기본값 설정`);
            }
          }
        }
      }
      
    } catch (error) {
      console.error(`[FinalReportGenerator] CSV 파일 분석 실패: ${csvFile.filename}`, error);
    }
  }
  
  return deviceResults;
}

/**
 * CSV 파일에서 디바이스 정보 추출 (상세한 전압 테이블 데이터 포함)
 * @param {string} headerLine - 헤더 라인
 * @param {Array} dataLines - 데이터 라인들
 * @param {string} filename - 파일명
 * @param {Array} deviceStates - 디바이스 선택 상태 배열
 * @param {Object} productInput - 제품 입력 정보
 * @returns {Object|null} 디바이스 정보
 */
function extractDeviceInfoFromCSV(headerLine, dataLines, filename, deviceStates, productInput) {
  try {
    console.log(`[FinalReportGenerator] CSV 파일 분석 시작: ${filename}`);
    
    // 상세한 전압 테이블 데이터를 저장할 구조
    const deviceData = {
      'Device 1': { measurements: {}, totalTests: 0, passedTests: 0, failedTests: 0 },
      'Device 2': { measurements: {}, totalTests: 0, passedTests: 0, failedTests: 0 },
      'Device 3': { measurements: {}, totalTests: 0, passedTests: 0, failedTests: 0 }
    };
    
    let processedDevices = 0;
    
    // dataLines에서 테이블 구조 분석 (saveTotaReportTableToFile 패턴)
    let inTableSection = false;
    let headerFound = false;
    
    for (const line of dataLines) {
      // 테이블 헤더 찾기 (saveTotaReportTableToFile 패턴)
      if (line.includes('INPUT,Product Number,1st,2nd,3rd,4th,5th,6th,7th,8th,9th,10th,A.Q.L') || line.includes('INPUT,제품번호,1st,2nd,3rd,4th,5th,6th,7th,8th,9th,10th,A.Q.L')) {
        inTableSection = true;
        headerFound = true;
        console.log(`[FinalReportGenerator] 테이블 헤더 발견: ${filename}`);
        continue;
      }
      
      // 테이블 데이터 행 처리 (다양한 제품번호 형태 지원)
      if (inTableSection && headerFound && (
        line.includes('V,C-') || 
        line.includes('V,C00') || 
        line.includes('V,1-') || 
        line.includes('V,2-') || 
        line.includes('V,3-') ||
        line.includes('V,A-') ||
        line.includes('V,B-') ||
        line.includes('V,D-') ||
        /V,\d+-\d+/.test(line) ||
        /V,[A-Z]-\d+/.test(line)
      )) {
        const parts = line.split(',');
        if (parts.length >= 13) { // INPUT,제품번호,1st~10th,A.Q.L = 13개 컬럼
          const inputVoltage = parts[0]; // 18V, 24V, 30V
          const productNumber = parts[1]; // C-001, C-002, C-003 또는 C005, C006, C007
          const aqlResult = parts[12]; // A.Q.L 컬럼의 G/N 결과
          
          // 1st~10th 측정값 추출 및 파싱
          const rawMeasurements = parts.slice(2, 12); // 1st~10th 컬럼
          const measurements = [];
          
          // 각 측정값을 파싱하여 실제 전압값 추출
          for (const rawMeasurement of rawMeasurements) {
            if (rawMeasurement && rawMeasurement !== '-') {
              // "221V|G" 형식에서 전압값만 추출
              const voltageMatch = rawMeasurement.match(/^([\d.-]+)V/);
              if (voltageMatch) {
                measurements.push(voltageMatch[1]);
              } else {
                // 숫자만 있는 경우 그대로 사용
                const numMatch = rawMeasurement.match(/^([\d.-]+)$/);
                if (numMatch) {
                  measurements.push(numMatch[1]);
                } else {
                  measurements.push('-');
                }
              }
            } else {
              measurements.push('-');
            }
          }
          
          // 제품번호에서 디바이스 번호 추출 (product_input.json 순서 기준)
          let deviceNumber = null;
          let deviceName = null;
          
          // product_input.json의 productNames 배열에서 순서로 디바이스 번호 결정
          const productNumbers = productInput?.productNames || ['A-001', 'B-002', 'C-003'];
          const deviceIndex = productNumbers.indexOf(productNumber);
          
          if (deviceIndex !== -1) {
            // product_input.json에서 찾은 경우, 인덱스 + 1이 디바이스 번호
            deviceNumber = deviceIndex + 1;
            deviceName = `Device ${deviceNumber}`;
            console.log(`[FinalReportGenerator] ${productNumber} -> ${deviceName} (product_input.json 순서 기준)`);
          } else {
            // product_input.json에서 찾지 못한 경우, 기존 로직 사용 (호환성)
            
            // 1. C-001, C-002, C-003 형식 처리
            const deviceMatch1 = productNumber.match(/C-00(\d+)/);
            if (deviceMatch1) {
              deviceNumber = parseInt(deviceMatch1[1]);
              deviceName = `Device ${deviceNumber}`;
              console.log(`[FinalReportGenerator] ${productNumber} -> ${deviceName} (C-00X 형식)`);
            } 
            // 2. C005, C006, C007 형식 처리 (기존 호환성)
            else if (productNumber.match(/C00(\d+)/)) {
              const deviceMatch2 = productNumber.match(/C00(\d+)/);
              deviceNumber = parseInt(deviceMatch2[1]) - 4; // C005=1, C006=2, C007=3
              deviceName = `Device ${deviceNumber}`;
              console.log(`[FinalReportGenerator] ${productNumber} -> ${deviceName} (C00X 형식)`);
            }
            // 3. 1-123, 2-124, 3-125 형식 처리 (숫자로 시작하는 제품번호)
            else if (productNumber.match(/^(\d+)-(\d+)$/)) {
              const deviceMatch3 = productNumber.match(/^(\d+)-(\d+)$/);
              deviceNumber = parseInt(deviceMatch3[1]);
              deviceName = `Device ${deviceNumber}`;
              console.log(`[FinalReportGenerator] ${productNumber} -> ${deviceName} (숫자-숫자 형식)`);
            }
            // 4. A-001, B-002, D-003 등 문자로 시작하는 제품번호 처리
            else if (productNumber.match(/^([A-Z])-(\d+)$/)) {
              const deviceMatch4 = productNumber.match(/^([A-Z])-(\d+)$/);
              const letter = deviceMatch4[1];
              const number = parseInt(deviceMatch4[2]);
              // A=1, B=2, C=3, D=4... 순서로 매핑
              deviceNumber = letter.charCodeAt(0) - 64; // A=65, B=66, C=67...
              deviceName = `Device ${deviceNumber}`;
              console.log(`[FinalReportGenerator] ${productNumber} -> ${deviceName} (문자-숫자 형식)`);
            }
            // 5. 기타 숫자로만 구성된 제품번호 (123, 124, 125 등)
            else if (productNumber.match(/^(\d+)$/)) {
              const deviceMatch5 = productNumber.match(/^(\d+)$/);
              const number = parseInt(deviceMatch5[1]);
              // 마지막 자리수로 디바이스 번호 결정 (123->3, 124->4, 125->5)
              deviceNumber = number % 10;
              if (deviceNumber === 0) deviceNumber = 10; // 0인 경우 10으로 처리
              deviceName = `Device ${deviceNumber}`;
              console.log(`[FinalReportGenerator] ${productNumber} -> ${deviceNumber} (숫자만 형식)`);
            } else {
              console.warn(`[FinalReportGenerator] ${productNumber} - 매칭되지 않는 제품번호 형식`);
            }
          }
          
          if (deviceNumber && deviceName) {
            const deviceIndex = deviceNumber - 1; // Device 1 -> index 0
            const isDeviceSelected = deviceStates[deviceIndex];
            
            if (aqlResult && (aqlResult === 'G' || aqlResult === 'NG' || aqlResult === 'N')) {
              const result = (aqlResult === 'G') ? 'G' : 'N';
              
              if (isDeviceSelected) {
                console.log(`[FinalReportGenerator] ${deviceName} (${inputVoltage} ${productNumber}): ${result} (선택됨)`);
                console.log(`[FinalReportGenerator] 측정값: [${measurements.join(', ')}]`);
                
                // 디바이스별 측정값 저장
                if (!deviceData[deviceName].measurements[inputVoltage]) {
                  deviceData[deviceName].measurements[inputVoltage] = {
                    productNumber: productNumber,
                    measurements: measurements,
                    aql: result
                  };
                }
                
                // 통계 업데이트
                deviceData[deviceName].totalTests++;
                if (result === 'G') {
                  deviceData[deviceName].passedTests++;
                } else {
                  deviceData[deviceName].failedTests++;
                }
                
                processedDevices++;
              } else {
                console.log(`[FinalReportGenerator] ${deviceName} (${inputVoltage} ${productNumber}): 선택되지 않음 - 건너뜀`);
              }
            }
          }
        }
      }
      
      // 테이블 섹션 종료 조건
      if (inTableSection && line.trim() === '') {
        inTableSection = false;
        headerFound = false;
        console.log(`[FinalReportGenerator] 테이블 섹션 종료: ${filename}`);
      }
    }
    
    // 처리된 디바이스가 없으면 기본값 설정 (3개 디바이스, 1개 채널)
    if (processedDevices === 0) {
      console.warn(`[FinalReportGenerator] ${filename}에서 A.Q.L 결과를 찾을 수 없음 - 기본값 설정`);
      const productNumbers = productInput?.productNames || ['A-001', 'B-002', 'C-003'];
      
      for (let i = 1; i <= 3; i++) {
        const deviceName = `Device ${i}`;
        const deviceIndex = i - 1;
        const isDeviceSelected = deviceStates[deviceIndex];
        
        if (isDeviceSelected) {
          const productNumber = productNumbers[i - 1] || `C-00${i}`;
          deviceData[deviceName] = {
            measurements: {
              '18V': { productNumber: productNumber, measurements: ['-','-','-','-','-','-','-','-','-','-'], aql: 'N' },
              '24V': { productNumber: productNumber, measurements: ['-','-','-','-','-','-','-','-','-','-'], aql: 'N' },
              '30V': { productNumber: productNumber, measurements: ['-','-','-','-','-','-','-','-','-','-'], aql: 'N' }
            },
            totalTests: 3,
            passedTests: 0,
            failedTests: 3
          };
        } else {
          deviceData[deviceName] = {
            measurements: {},
            totalTests: 0,
            passedTests: 0,
            failedTests: 0
          };
        }
      }
    }
    
    console.log(`[FinalReportGenerator] ${filename}에서 총 ${processedDevices}개의 디바이스 결과 처리 완료`);
    
    return {
      deviceName: 'All Devices', // 전체 디바이스 정보
      deviceData: deviceData // 상세한 디바이스별 측정 데이터
    };
    
  } catch (error) {
    console.error(`[FinalReportGenerator] 디바이스 정보 추출 실패: ${filename}`, error);
    return null;
  }
}

/**
 * 디바이스별 결과를 바탕으로 최종 결론 생성 (전압별 그룹 단위 G/NG 판단)
 * @param {Object} deviceResults - 디바이스별 분석 결과
 * @param {Array} deviceStates - 디바이스 선택 상태 배열
 * @returns {Object} 최종 결론
 */
function generateFinalConclusions(deviceResults, deviceStates) {
  const finalConclusions = {};
  
  // 전압별 그룹 결과를 저장할 객체
  const voltageGroupResults = {
    '18V': { devices: [], allGood: true },
    '24V': { devices: [], allGood: true },
    '30V': { devices: [], allGood: true }
  };
  
  // 1단계: 각 디바이스별로 전압별 결과 수집 (파일별 결과 포함)
  for (const [deviceName, results] of Object.entries(deviceResults)) {
    // 디바이스 선택 상태 확인
    const deviceIndex = parseInt(deviceName.split(' ')[1]) - 1; // Device 1 -> index 0
    const isDeviceSelected = deviceStates[deviceIndex];
    
    if (isDeviceSelected && results.measurements) {
      // 각 전압별로 결과 수집
      for (const [voltage, measurementData] of Object.entries(results.measurements)) {
        if (voltageGroupResults[voltage]) {
          voltageGroupResults[voltage].devices.push({
            deviceName: deviceName,
            aql: measurementData.aql,
            productNumber: measurementData.productNumber,
            fileResults: measurementData.fileResults || {} // 파일별 결과 포함
          });
          
          // 개별 디바이스별 판단이므로 그룹 결과는 개별 결과와 동일
          // (프론트엔드와 일치하도록 수정)
        }
      }
    }
  }
  
  // 전압별 그룹 결과 최종 확인 및 로깅 (개별 디바이스별 판단)
  for (const [voltage, groupResult] of Object.entries(voltageGroupResults)) {
    console.log(`[FinalReportGenerator] ${voltage} 그룹 개별 디바이스별 판단 (디바이스 수: ${groupResult.devices.length})`);
    groupResult.devices.forEach(device => {
      console.log(`[FinalReportGenerator]   - ${device.deviceName}: ${device.aql}`);
    });
  }
  
  // 2단계: 전압별 그룹 결과를 바탕으로 디바이스별 최종 결론 생성
  for (const [deviceName, results] of Object.entries(deviceResults)) {
    const deviceIndex = parseInt(deviceName.split(' ')[1]) - 1; // Device 1 -> index 0
    const isDeviceSelected = deviceStates[deviceIndex];
    
    if (isDeviceSelected) {
      if (results.totalTests > 0) {
        // 해당 디바이스가 참여한 모든 전압에서 G인지 확인
        // 모든 전압(18V, 24V, 30V)에서 G여야 디바이스가 G가 됨
        let deviceConclusion = 'G'; // 기본값은 G
        
        // 각 전압별로 결과 확인
        const requiredVoltages = ['18V', '24V', '30V'];
        for (const voltage of requiredVoltages) {
          if (results.measurements[voltage] && results.measurements[voltage].aql !== 'G') {
            // 하나라도 G가 아니면 전체 디바이스는 N
            deviceConclusion = 'N';
            console.log(`[FinalReportGenerator] ${deviceName} ${voltage}에서 ${results.measurements[voltage].aql} 발견 - 디바이스 결론: N`);
            break;
          }
        }
        
        finalConclusions[deviceName] = {
          conclusion: deviceConclusion,
          totalTests: results.totalTests,
          passedTests: results.passedTests,
          failedTests: results.failedTests,
          passRate: ((results.passedTests / results.totalTests) * 100).toFixed(2),
          measurements: results.measurements || {}, // 상세한 측정 데이터 포함 (파일별 결과 포함)
          channels: results.channels,
          isSelected: true,
          voltageGroupResults: voltageGroupResults // 전압별 그룹 결과 포함
        };
        
        console.log(`[FinalReportGenerator] ${deviceName} 최종 결론: ${deviceConclusion} (개별 디바이스별 판단 적용) - 선택됨`);
        console.log(`[FinalReportGenerator] 전압별 개별 디바이스 결과: 18V=${voltageGroupResults['18V'].devices.length}개, 24V=${voltageGroupResults['24V'].devices.length}개, 30V=${voltageGroupResults['30V'].devices.length}개`);
      }
    } else {
      // 선택되지 않은 디바이스는 "-.-" 표시
      finalConclusions[deviceName] = {
        conclusion: '-.-',
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        passRate: '0.00',
        measurements: {}, // 빈 측정 데이터
        channels: results.channels,
        isSelected: false,
        voltageGroupResults: voltageGroupResults
      };
      
      console.log(`[FinalReportGenerator] ${deviceName} 최종 결론: -.- (선택되지 않음)`);
    }
  }
  
  return finalConclusions;
}

/**
 * CSV 파일에서 측정 섹션 추출 (헤더 + 데이터 행)
 * @param {string} filePath - CSV 파일 경로
 * @returns {Array} 측정 섹션 라인 배열
 */
function extractMeasurementSectionFromCSV(filePath) {
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split('\n');
    
    // 측정 섹션 찾기 (INPUT,Product Number,1st,2nd... 헤더부터 시작)
    let measurementLines = [];
    let inMeasurementSection = false;
    
    for (const line of lines) {
      // 테이블 헤더 찾기
      if (line.includes('INPUT,Product Number,1st,2nd,3rd,4th,5th,6th,7th,8th,9th,10th,A.Q.L') ||
          line.includes('INPUT,제품번호,1st,2nd,3rd,4th,5th,6th,7th,8th,9th,10th,A.Q.L')) {
        inMeasurementSection = true;
        measurementLines.push(line.trim());
        continue;
      }
      
      // 측정 섹션이 시작되었고, 데이터 행을 찾음
      if (inMeasurementSection) {
        // 빈 줄이 나오면 측정 섹션 종료
        if (line.trim() === '' && measurementLines.length > 1) {
          break;
        }
        // 빈 줄이 아닌 경우 추가
        if (line.trim() !== '') {
          measurementLines.push(line.trim());
        }
      }
    }
    
    console.log(`[FinalReportGenerator] ${path.basename(filePath)}에서 측정 섹션 추출: ${measurementLines.length}줄`);
    return measurementLines;
  } catch (error) {
    console.error(`[FinalReportGenerator] CSV 파일 읽기 실패: ${filePath}`, error);
    return [];
  }
}

/**
 * 최종보고서 파일 생성
 * @param {Object} finalConclusions - 최종 결론
 * @param {string} directoryPath - 디렉토리 경로
 * @param {string} directoryName - 디렉토리 이름
 * @param {Array} deviceStates - 디바이스 선택 상태 배열
 * @param {Object} productInput - 제품 입력 정보
 * @returns {Object} 파일 생성 결과
 */
async function createFinalReportFile(finalConclusions, directoryPath, directoryName, deviceStates, productInput) {
  try {
    console.log(`[FinalReportGenerator] 최종보고서 파일 생성 시작`);
    console.log(`[FinalReportGenerator] 디렉토리 경로: ${directoryPath}`);
    
    // 디렉토리 존재 확인 및 생성
    if (!fs.existsSync(directoryPath)) {
      console.warn(`[FinalReportGenerator] 디렉토리가 존재하지 않음, 생성 시도: ${directoryPath}`);
      try {
        fs.mkdirSync(directoryPath, { recursive: true });
        console.log(`[FinalReportGenerator] 디렉토리 생성 완료: ${directoryPath}`);
      } catch (error) {
        console.error(`[FinalReportGenerator] 디렉토리 생성 실패: ${directoryPath}`, error);
        throw new Error(`Failed to create directory: ${directoryPath} - ${error.message}`);
      }
    }
    
    // 디렉토리 쓰기 권한 확인
    try {
      fs.accessSync(directoryPath, fs.constants.W_OK);
    } catch (error) {
      console.error(`[FinalReportGenerator] 디렉토리 쓰기 권한 없음: ${directoryPath}`);
      throw new Error(`No write permission for directory: ${directoryPath}`);
    }
    
    // 파일명 생성 (안전한 타임스탬프 사용)
    const timestamp = getSafeTimestamp();
    const reportFilename = `${timestamp}_Final_Device_Report.csv`;
    const reportFilePath = path.join(directoryPath, reportFilename);
    
    console.log(`[FinalReportGenerator] 보고서 파일 경로: ${reportFilePath}`);
    
    // CSV 보고서 내용 생성
    let reportContent = '';
    
    // 헤더 정보 (실제 제품 입력 정보 사용)
    const modelName = productInput?.modelName || 'Unknown Model';
    const productNumbers = productInput?.productNames || ['A-001', 'B-002', 'C-003'];
    const productNumberString = productNumbers.join(';');
    
    reportContent += `Document No.,K2-AD-110-A241023-001\n`;
    reportContent += `Product Name,${modelName}\n`;
    reportContent += `Product Number,${productNumberString}\n`;
    reportContent += `Test Date,${new Date().toLocaleDateString('en-US')}\n`;
    reportContent += `Test Time,${new Date().toLocaleTimeString('en-US')}\n`;
    reportContent += `Test Temperature,Comprehensive Analysis\n`;
    reportContent += `Total Cycles,1\n`;
    reportContent += `Test Type,Device Comprehensive Test Report\n`;
    reportContent += `Generated Date,${getFormattedDateTime()}\n`;
    reportContent += `Source Directory,${directoryName || path.basename(directoryPath)}\n`;
    reportContent += `\n`;
    
    // CSV 파일들을 검색하고 순서대로 처리
    const csvFiles = scanCSVFilesInDirectory(directoryPath);
    console.log(`[FinalReportGenerator] 발견된 CSV 파일: ${csvFiles.length}개`);
    
    // 각 CSV 파일의 측정 섹션을 그대로 복사
    for (const csvFile of csvFiles) {
      const measurementLines = extractMeasurementSectionFromCSV(csvFile.filepath);
      
      if (measurementLines.length > 0) {
        // 파일명 헤더 추가
        reportContent += `=== ${csvFile.filename} ===\n`;
        
        // 측정 데이터 라인들을 그대로 추가
        for (const line of measurementLines) {
          reportContent += `${line}\n`;
        }
        reportContent += `\n`;
      }
    }
    
    reportContent += `\n`;
    
    // Test results summary (xxx_Cycle_HighTemp_Test.csv와 동일한 형태)
    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;
    
    // 선택된 Device의 모든 측정값을 확인하여 통계 계산
    for (const [deviceName, conclusion] of Object.entries(finalConclusions)) {
      if (conclusion.isSelected && conclusion.totalTests > 0) {
        totalTests += conclusion.totalTests;
        passedTests += conclusion.passedTests;
        failedTests += conclusion.failedTests;
      }
    }
    
    reportContent += `Test Results Summary\n`;
    reportContent += `Total Tests,${totalTests}\n`;
    reportContent += `Passed Tests,${passedTests}\n`;
    reportContent += `Failed Tests,${failedTests}\n`;
    reportContent += `Pass Rate,${totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(2) : 0}%\n`;
    reportContent += `\n`;
    
    // 디바이스별 상세 결과
    reportContent += `Device Details\n`;
    reportContent += `Device,Conclusion,Total Tests,Passed Tests,Failed Tests,Pass Rate,Selected\n`;
    
    for (const [deviceName, result] of Object.entries(finalConclusions)) {
      const selectedStatus = result.isSelected ? 'Yes' : 'No';
      
      // deviceName (예: "Device 1")에서 숫자를 추출하여 Product Number로 변환
      const deviceMatch = deviceName.match(/Device\s+(\d+)/);
      let displayDeviceName = deviceName;
      
      if (deviceMatch) {
        const deviceIndex = parseInt(deviceMatch[1]) - 1; // Device 1 -> index 0
        if (deviceIndex >= 0 && deviceIndex < productNumbers.length) {
          displayDeviceName = productNumbers[deviceIndex];
        }
      }
      
      reportContent += `${displayDeviceName},${result.conclusion},${result.totalTests},${result.passedTests},${result.failedTests},${result.passRate}%,${selectedStatus}\n`;
    }
    
    reportContent += `\n`;
    
    // 채널별 상세 결과 (전압별로 표시)
    reportContent += `Channel Details\n`;
    reportContent += `Device,Channel,Total Cycles x 2 x ON/OFF times,G (Pass),NG (Fail),Selected\n`;
    
    const voltageList = ['18V', '24V', '30V'];
    
    // 사이클 수 계산 (CSV 파일명에서 사이클 번호 추출)
    let maxCycle = 0;
    const csvFilesForCycle = scanCSVFilesInDirectory(directoryPath);
    for (const csvFile of csvFilesForCycle) {
      const cycleMatch = csvFile.filename.match(/Cycle(\d+)/);
      if (cycleMatch) {
        const cycleNumber = parseInt(cycleMatch[1]);
        if (cycleNumber > maxCycle) {
          maxCycle = cycleNumber;
        }
      }
    }
    const totalCycles = maxCycle > 0 ? maxCycle : 1;
    
    // 고온/저온 설정에서 ON/OFF 회수 가져오기
    const highTempSettings = loadHighTempSettings();
    const lowTempSettings = loadLowTempSettings();
    const onOffCount = highTempSettings.readCount || 3; // 고온측정설정의 ON/OFF 회수 사용 (기본값 3)
    
    for (const [deviceName, result] of Object.entries(finalConclusions)) {
      const selectedStatus = result.isSelected ? 'Yes' : 'No';
      
      // deviceName (예: "Device 1")에서 숫자를 추출하여 Product Number로 변환
      const deviceMatch = deviceName.match(/Device\s+(\d+)/);
      let displayDeviceName = deviceName;
      
      if (deviceMatch) {
        const deviceIndex = parseInt(deviceMatch[1]) - 1; // Device 1 -> index 0
        if (deviceIndex >= 0 && deviceIndex < productNumbers.length) {
          displayDeviceName = productNumbers[deviceIndex];
        }
      }
      
      // 첫 번째 전압에서는 Device 이름을 표시하고, 나머지는 빈 값
      let isFirstVoltage = true;
      
      for (const voltage of voltageList) {
        const channelData = result.measurements && result.measurements[voltage];
        
        if (channelData) {
          // 각 전압별 데이터가 있는 경우
          // Total Cycles x 2 (고온+저온) x ON/OFF 횟수
          const totalTests = totalCycles * 2 * onOffCount;
          
          // G와 NG 개수 계산 (실제 측정값 기반)
          let passCount = 0;
          let failCount = 0;
          
          // fileResults에서 각 파일의 측정값들을 확인
          if (channelData.fileResults) {
            for (const [fileName, fileResult] of Object.entries(channelData.fileResults)) {
              if (fileResult.measurements && Array.isArray(fileResult.measurements)) {
                for (const measurement of fileResult.measurements) {
                  if (measurement && measurement !== '-' && measurement !== '-.-') {
                    const value = parseFloat(measurement);
                    if (!isNaN(value)) {
                      // 200-242 범위 내에 있으면 G, 아니면 NG
                      if (value >= 200 && value <= 242) {
                        passCount++;
                      } else {
                        failCount++;
                      }
                    }
                  }
                }
              }
            }
          } else if (channelData.measurements && Array.isArray(channelData.measurements)) {
            // fileResults가 없으면 채널 데이터의 측정값들을 확인
            for (const measurement of channelData.measurements) {
              if (measurement && measurement !== '-' && measurement !== '-.-') {
                const value = parseFloat(measurement);
                if (!isNaN(value)) {
                  // 200-242 범위 내에 있으면 G, 아니면 NG
                  if (value >= 200 && value <= 242) {
                    passCount++;
                  } else {
                    failCount++;
                  }
                }
              }
            }
          }
          
          if (isFirstVoltage) {
            reportContent += `${displayDeviceName},${voltage},${totalTests},${passCount},${failCount},${selectedStatus}\n`;
            isFirstVoltage = false;
          } else {
            reportContent += `,${voltage},${totalTests},${passCount},${failCount},${selectedStatus}\n`;
          }
        } else {
          // 전압별 데이터가 없는 경우
          const totalTests = totalCycles * 2 * onOffCount;
          if (isFirstVoltage) {
            reportContent += `${displayDeviceName},${voltage},${totalTests},0,0,${selectedStatus}\n`;
            isFirstVoltage = false;
          } else {
            reportContent += `,${voltage},${totalTests},0,0,${selectedStatus}\n`;
          }
        }
      }
    }
    
    reportContent += `\n`;
    
    // 통계 정보 (선택된 디바이스만)
    const selectedDevices = Object.values(finalConclusions).filter(c => c.isSelected);
    const totalSelectedDevices = selectedDevices.length;
    const goodDevices = selectedDevices.filter(c => c.conclusion === 'G').length;
    const notGoodDevices = selectedDevices.filter(c => c.conclusion === 'N').length;
    const notSelectedDevices = Object.values(finalConclusions).filter(c => !c.isSelected).length;
    
    reportContent += `Summary\n`;
    reportContent += `Total Devices,${Object.keys(finalConclusions).length}\n`;
    reportContent += `Selected Devices,${totalSelectedDevices}\n`;
    reportContent += `Not Selected Devices,${notSelectedDevices}\n`;
    reportContent += `Good Devices,${goodDevices}\n`;
    reportContent += `Not Good Devices,${notGoodDevices}\n`;
    reportContent += `Pass Rate,${totalSelectedDevices > 0 ? ((goodDevices / totalSelectedDevices) * 100).toFixed(2) : 0}%\n`;
    
    // 파일 저장 (안전한 방식)
    console.log(`[FinalReportGenerator] 파일 쓰기 시작: ${reportFilePath}`);
    fs.writeFileSync(reportFilePath, reportContent, 'utf8');
    console.log(`[FinalReportGenerator] 파일 쓰기 완료: ${reportFilePath}`);
    
    // 파일 생성 확인
    if (fs.existsSync(reportFilePath)) {
      const stats = fs.statSync(reportFilePath);
      console.log(`[FinalReportGenerator] 파일 생성 확인: ${stats.size} bytes`);
    } else {
      throw new Error(`File was not created: ${reportFilePath}`);
    }
    
    return {
      filename: reportFilename,
      filePath: reportFilePath,
      totalDevices: Object.keys(finalConclusions).length,
      selectedDevices: totalSelectedDevices,
      notSelectedDevices: notSelectedDevices,
      goodDevices,
      notGoodDevices
    };
    
  } catch (error) {
    console.error(`[FinalReportGenerator] 파일 생성 실패:`, error);
    throw error;
  }
}

