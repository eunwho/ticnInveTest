import { GetData } from './GetData.js';
import { RelayAllOff, SelectDeviceOn, SelectDeviceOff } from './SelectDevice.js';
import { SendVoltCommand } from './SetVolt.js';
import { ReadVolt } from './ReadVolt.js';
import { ReadChamber } from './ReadChamber.js'; 
import { getProcessStopRequested, setProcessStopRequested, setMachineRunningStatus, getCurrentChamberTemperature, getSafeGetTableOption } from './backend-websocket-server.js';
import { getSimulationMode, saveTotaReportTableToFile, generateFinalDeviceReport, generateInterruptedTestResultFile, broadcastTableData, updateTableData, getCurrentTableData, resetTableData, setCurrentTestDirectoryPath } from './RunTestProcess.js';
import { generateFinalReportFromDirectory } from './FinalReportGenerator.js';
import { sleep, getFormattedDateTime, getDateDirectoryName, Now } from './utils/common.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { InterByteTimeoutParser } from 'serialport';

// ES Module 환경에서 __dirname 사용을 위한 설정
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 시뮬레이션 모드는 RunTestProcess.js에서 관리됨

// 전역 WebSocket 서버 참조를 위한 변수
let globalWss = null;

// 테스트 실행별 디렉토리명을 저장하는 전역 변수
let currentTestDirectoryName = null;
// 테스트 실행별 전체 디렉토리 경로를 저장하는 전역 변수
let currentTestDirectoryPath = null;

// 전역 테이블 데이터 저장소
let globalTableData = {
  devices: Array.from({ length: 10 }, (_, deviceIndex) => ({
    deviceNumber: deviceIndex + 1,
    tests: Array.from({ length: 3 }, (_, testIndex) => ({
      testNumber: testIndex + 1,
      reads: Array.from({ length: 10 }, (_, readIndex) => ({
        readIndex: readIndex + 1,
        channels: Array.from({ length: 1 }, (_, channelIndex) => ({
          channelNumber: channelIndex + 1,
          voltage: null,
          timestamp: null,
          status: 'pending'
        }))
      }))
    }))
  })),
  lastUpdate: null,
  isComplete: false
};

// TIME_PROGRESS 메시지 첫 번째 전송 제어를 위한 전역 변수
let isFirstTimeProgressSent = false;

// 테이블 데이터 전송 디바운싱을 위한 전역 변수
let tableDataBroadcastTimeout = null;
let lastTableDataBroadcast = 0;

// WebSocket 서버 참조를 설정하는 함수
export function setWebSocketServer(wss) {
  globalWss = wss;
  console.log('[RunTestProcess] WebSocket 서버 참조 설정됨');
}

// 전역 변수를 설정하는 함수 (RunTestProcess.js에서 import하여 사용)

// 전역 변수를 가져오는 함수
export function getCurrentTestDirectoryPath() {
  return currentTestDirectoryPath;
}

// 디바운싱된 테이블 데이터 전송 함수 (TimeMode 최적화)
async function debouncedBroadcastTableData(force = false) {
  const now = Date.now();
  const minInterval = 1000; // TimeMode용 최소 1초 간격 (더 빠른 업데이트)
  
  // 강제 전송이거나 최소 간격이 지났을 때만 전송
  if (force || (now - lastTableDataBroadcast) >= minInterval) {
    // 기존 타임아웃 취소
    if (tableDataBroadcastTimeout) {
      clearTimeout(tableDataBroadcastTimeout);
      tableDataBroadcastTimeout = null;
    }
    
    try {
      await broadcastTableData();
      lastTableDataBroadcast = now;
      console.log(`[DebouncedBroadcast] 테이블 데이터 전송 완료 (강제: ${force})`);
    } catch (error) {
      console.error(`[DebouncedBroadcast] 테이블 데이터 전송 실패:`, error);
    }
  } else {
    // 디바운싱: 기존 타임아웃 취소하고 새로운 타임아웃 설정
    if (tableDataBroadcastTimeout) {
      clearTimeout(tableDataBroadcastTimeout);
    }
    
    const remainingTime = minInterval - (now - lastTableDataBroadcast);
    tableDataBroadcastTimeout = setTimeout(async () => {
      try {
        await broadcastTableData();
        lastTableDataBroadcast = Date.now();
        console.log(`[DebouncedBroadcast] 디바운싱된 테이블 데이터 전송 완료`);
      } catch (error) {
        console.error(`[DebouncedBroadcast] 디바운싱된 테이블 데이터 전송 실패:`, error);
      }
      tableDataBroadcastTimeout = null;
    }, remainingTime);
    
    console.log(`[DebouncedBroadcast] 테이블 데이터 전송 디바운싱 (${remainingTime}ms 후 전송)`);
  }
}

// 프로세스 로그를 클라이언트에게 전송하는 함수
function sendProcessLog(message) {
  if (globalWss) {
    const logMessage = `[PROCESS_LOG] ${message}`;
    let sentCount = 0;
    globalWss.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(logMessage);
        sentCount++;
      }
    });
    // console.log(`[ProcessLog] 전송 완료 - 클라이언트 수: ${sentCount}, 메시지: ${message}`);
  }
}

// 시간 진행 상황을 클라이언트에게 전송하는 함수
function sendTimeProgress(data) {
  if (globalWss) {
    const timeProgressMessage = `[TIME_PROGRESS] ${JSON.stringify(data)}`;
    let sentCount = 0;
    globalWss.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(timeProgressMessage);
        sentCount++;
      }
    });
    console.log(`[TimeProgress] 전송 완료 - 클라이언트 수: ${sentCount}, 데이터:`, data);
  }
}

// 1분 간격으로 시간 진행 상황을 업데이트하는 함수
function startTimeProgressUpdates(startTime, totalDuration, currentPhase = 'waiting') {
  // 즉시 첫 번째 업데이트 실행
  const updateTimeProgress = () => {
    const currentTime = Date.now();
    const elapsedTime = currentTime - startTime;
    const remainingTime = Math.max(0, totalDuration - elapsedTime);
    
    const timeProgressData = {
      phase: currentPhase,
      startTime: startTime,
      currentTime: currentTime,
      elapsedTime: elapsedTime,
      totalDuration: totalDuration,
      remainingTime: remainingTime,
      elapsedMinutes: Math.round(elapsedTime / 60000),
      remainingMinutes: Math.round(remainingTime / 60000),
      totalMinutes: Math.round(totalDuration / 60000),
      progressPercentage: Math.min(100, Math.round((elapsedTime / totalDuration) * 100)),
      timestamp: new Date().toISOString()
    };
    
    // runTimeModeTestProcess에서는 계속 시간 진행 상황 업데이트 전송
    console.log('📤 Sending TIME_PROGRESS message - totalMinutes:', timeProgressData.totalMinutes);
    sendTimeProgress(timeProgressData);
    
    // 시간이 다 되었으면 인터벌 정리
    if (remainingTime <= 0) {
      clearInterval(intervalId);
    }
  };
  
  // 즉시 첫 번째 업데이트 실행
  updateTimeProgress();
  
  // 그 후 1분 간격으로 업데이트
  const intervalId = setInterval(updateTimeProgress, 60000);
  
  return intervalId;
}

function getDateTimeSeparated() {
  const now = new Date(); // 현재 날짜와 시간을 포함하는 Date 객체 생성

  // 날짜 부분만 로컬 형식으로 가져오기
  const dateOptions = {
    year: 'numeric',
    month: 'long', // 'numeric', '2-digit', 'short', 'long' 중 선택
    day: 'numeric'
  };
  const dateString = now.toLocaleDateString(undefined, dateOptions); // undefined는 현재 로케일을 사용하겠다는 의미

  // 시간 부분만 로컬 형식으로 가져오기
  const timeOptions = {
    hour: '2-digit',   // 'numeric', '2-digit' 중 선택
    minute: '2-digit', // 'numeric', '2-digit' 중 선택
    second: '2-digit', // 'numeric', '2-digit' 중 선택
    hourCycle: 'h23'   // 'h11', 'h12', 'h23', 'h24' 중 선택 (24시간제로 설정)
  };
  const timeString = now.toLocaleTimeString(undefined, timeOptions);

  return {
    date: dateString,
    time: timeString
  };
}

const RawVoltTable = [];

// 첫 번째 차원 (3)
for (let i = 0; i < 3; i++) {
  RawVoltTable[i] = []; // 두 번째 차원을 위한 배열 초기화
  // 두 번째 차원 (10)
  for (let j = 0; j < 10; j++) {
    RawVoltTable[i][j] = []; // 세 번째 차원을 위한 배열 초기화
    // 세 번째 차원 (4)
    for (let k = 0; k < 4; k++) {
      RawVoltTable[i][j][k] = ""; // 초기값 ""으로 설정
    }
  }
}

let pageTable = {
  TestDate: '',
  TestTime: '',
  TestTemperature: '',
  voltagTable: RawVoltTable
}

let TotaReportTable = {
  modelName: '',
  ProductNumber: [],
  inputVolt: [],
  reportTable: [pageTable, pageTable, pageTable, pageTable, pageTable, 
    pageTable, pageTable, pageTable, pageTable, pageTable]
}

// 사이클별 결과를 저장할 전역 변수
let cycleResults = [];
  
/**
 * 밀리초 단위 대기 함수
 * @param {number} ms - 대기할 밀리초
 * @returns {Promise} 대기 완료 후 resolve되는 Promise
 */

/**
 * 분 단위 대기 함수 (최대 999분까지 지원)
 * @param {number} minutes - 대기할 분 (1-999)
 * @returns {Promise} 대기 완료 후 resolve되는 Promise
 */
function sleepMinutes(minutes) {
  // 입력값 검증
  if (typeof minutes !== 'number' || minutes < 1 || minutes > 999) {
    console.warn(`[sleepMinutes] 잘못된 분 값: ${minutes}. 1-999 범위의 값이어야 합니다.`);
    return Promise.resolve();
  }
  
  const milliseconds = minutes * 60 * 1000; // 분을 밀리초로 변환
  console.log(`[sleepMinutes] ${minutes}분 대기 시작 (${milliseconds}ms)`);
  
  return new Promise(resolve => {
    setTimeout(() => {
      console.log(`[sleepMinutes] ${minutes}분 대기 완료`);
      resolve();
    }, milliseconds);
  });
}

/**
 * 중지 요청을 확인할 수 있는 분 단위 대기 함수
 * @param {number} minutes - 대기할 분 (1-999)
 * @param {string} context - 대기 중인 컨텍스트 (로그용)
 * @returns {Promise} 대기 완료 후 resolve되는 Promise, 중지 요청 시 reject
 */
function sleepMinutesWithStopCheck(minutes, context = '') {
  // 입력값 검증
  if (typeof minutes !== 'number' || minutes < 1 || minutes > 999) {
    console.warn(`[sleepMinutesWithStopCheck] 잘못된 분 값: ${minutes}. 1-999 범위의 값이어야 합니다.`);
    return Promise.resolve();
  }
  
  const milliseconds = minutes * 60 * 1000; // 분을 밀리초로 변환
  const checkInterval = 5000; // 5초마다 중지 요청 확인
  const contextStr = context ? ` [${context}]` : '';
  
  console.log(`[sleepMinutesWithStopCheck]${contextStr} ${minutes}분 대기 시작 (${milliseconds}ms) - 중지 요청 확인 간격: ${checkInterval}ms`);
  
  // 시간 진행 상황 업데이트 시작
  const startTime = Date.now();
  const timeProgressInterval = startTimeProgressUpdates(startTime, milliseconds, 'waiting');
  
  return new Promise((resolve, reject) => {
    let elapsed = 0;
    
    const checkStop = () => {
      // 중지 요청 확인
      if (getProcessStopRequested()) {
        console.log(`[sleepMinutesWithStopCheck]${contextStr} 🛑 중지 요청 감지 - 대기 중단 (경과: ${Math.round(elapsed/1000)}초/${minutes}분)`);
        
        // 시간 진행 상황 인터벌 정리
        if (timeProgressInterval) {
          clearInterval(timeProgressInterval);
        }
        
        reject(new Error('PROCESS_STOP_REQUESTED'));
        return;
      }
      
      elapsed = Date.now() - startTime;
      
      if (elapsed >= milliseconds) {
        console.log(`[sleepMinutesWithStopCheck]${contextStr} ${minutes}분 대기 완료`);
        
        // 시간 진행 상황 인터벌 정리
        if (timeProgressInterval) {
          clearInterval(timeProgressInterval);
        }
        
        resolve();
      } else {
        // 다음 체크까지 대기
        setTimeout(checkStop, Math.min(checkInterval, milliseconds - elapsed));
      }
    };
    
    // 첫 번째 체크 시작
    setTimeout(checkStop, Math.min(checkInterval, milliseconds));
  });
}





/**
 * 전압값을 고정 범위(200 <= 측정값 <= 242)로 비교하여 G/N 판정
 * @param {number} readVoltage - 읽은 전압값
 * @param {number} expectedVoltage - 설정된 전압값 (사용하지 않음, 호환성을 위해 유지)
 * @returns {string} "G" (Good) 또는 "N" (Not Good)
 */
function compareVoltage(readVoltage, expectedVoltage) {
  // 읽은 전압이 숫자가 아니거나 에러인 경우
  if (typeof readVoltage !== 'number' || isNaN(readVoltage)) {
    console.log(`[compareVoltage] 유효하지 않은 전압값: ${readVoltage} (타입: ${typeof readVoltage})`);
    return "N";
  }
  
  // 고정 범위: 200 <= 측정값 <= 242 (200과 242 포함)
  const minVoltage = 200;
  const maxVoltage = 242;
  
  // 범위 내에 있는지 확인
  const isInRange = readVoltage >= minVoltage && readVoltage <= maxVoltage;
  const result = isInRange ? "G" : "N";
  
  // 디버깅을 위한 로그 추가
  console.log(`[compareVoltage] 전압값: ${readVoltage}, 범위: ${minVoltage}-${maxVoltage}, 결과: ${result}`);
  
  return result;
}

/**
 * 전압값을 소수점 2자리로 자르는 함수
 * @param {string} voltageValue - 전압값 문자열 (예: "221V|G")
 * @returns {string} 소수점 2자리로 자른 전압값
 */
function truncateVoltageToTwoDecimals(voltageValue) {
  if (!voltageValue || typeof voltageValue !== 'string') {
    return voltageValue;
  }
  
  const parts = voltageValue.split('|');
  if (parts.length >= 2) {
    const voltagePart = parts[0];
    const comparisonPart = parts[1];
    
    // 전압값에서 V 제거하고 숫자로 변환
    const voltage = parseFloat(voltagePart.replace('V', ''));
    if (!isNaN(voltage)) {
      // 소수점 2자리로 자르기 (3자리 이하 버림)
      const truncatedVoltage = Math.floor(voltage * 100) / 100;
      return `${truncatedVoltage}V|${comparisonPart}`;
    }
  }
  
  return voltageValue;
}

// 테스트를 위한 PowerTable 초기화 함수
export function testPowerTableReset() {
  if (globalWss) {
    const testResetMessage = `[POWER_TABLE_RESET] ${JSON.stringify({
      action: 'test_reset',
      timestamp: new Date().toISOString(),
      message: '테스트용 PowerTable 초기화'
    })}`;
    
    let sentCount = 0;
    globalWss.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(testResetMessage);
        sentCount++;
      }
    });
    console.log(`[TestPowerTableReset] 테스트 초기화 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
    return { success: true, sentCount };
  } else {
    console.error(`[TestPowerTableReset] 전역 WebSocket 서버가 설정되지 않음`);
    return { success: false, error: 'WebSocket 서버 미설정' };
  }
}

// 페이지 단위 테스트 프로세스 실행 (readCount 반복 포함) - RunTestProcess.js와 동일한 구현
export async function runSinglePageProcess(readCount = 1) {
  // 중단 보고서 생성을 위한 변수들
  let stopInfo = null;
  
  try {
    const modeText = getSimulationMode() ? '시뮬레이션 모드' : '실제 모드';
    console.log(`[SinglePageProcess] 🔧 단일 페이지 프로세스 시작 (${modeText}) - readCount: ${readCount}`);
    
    // 파워스위치 상태 확인
    const { getMachineRunningStatus } = await import('./backend-websocket-server.js');
    const isPowerOn = getMachineRunningStatus();
    
    if (!isPowerOn) {
      console.error(`[SinglePageProcess] ❌ 파워스위치가 OFF 상태입니다. 테스트를 중단합니다.`);
      stopInfo = { 
        status: 'stopped', 
        message: '파워스위치가 OFF 상태 - 테스트를 실행할 수 없습니다',
        errorType: 'power_switch_off',
        stoppedAtPhase: 'power_check'
      };
      return stopInfo;
    }

    // runSinglePageProcess 시작 시마다 테이블 데이터 초기화 (각 단계마다 새로 시작)
    // 초기화 전 상태 로깅
    const beforeReset = getCurrentTableData();
    const beforeCompletedCells = beforeReset.devices.reduce((total, device) => {
      return total + device.tests.reduce((testTotal, test) => {
        return testTotal + test.reads.reduce((readTotal, read) => {
          return readTotal + read.channels.filter(channel => channel.status === 'completed').length;
        }, 0);
      }, 0);
    }, 0);
    console.log(`[SinglePageProcess] 🔍 초기화 전 상태 - 완료된 셀: ${beforeCompletedCells}, Device 1 Test 1 Read 1: ${beforeReset.devices[0]?.tests[0]?.reads[0]?.channels[0]?.voltage || 'null'}`);
    
    resetTableData();
    
    // 초기화 후 상태 로깅
    const afterReset = getCurrentTableData();
    const afterCompletedCells = afterReset.devices.reduce((total, device) => {
      return total + device.tests.reduce((testTotal, test) => {
        return testTotal + test.reads.reduce((readTotal, read) => {
          return readTotal + read.channels.filter(channel => channel.status === 'completed').length;
        }, 0);
      }, 0);
    }, 0);
    console.log(`[SinglePageProcess] 🔍 초기화 후 상태 - 완료된 셀: ${afterCompletedCells}, Device 1 Test 1 Read 1: ${afterReset.devices[0]?.tests[0]?.reads[0]?.channels[0]?.voltage || 'null'}`);
    console.log(`[SinglePageProcess] ✅ 단일 페이지 프로세스 시작 - 테이블 데이터 초기화 완료`);
    
    // PowerTable 초기화 메시지 전송 (각 단계마다 테이블 리셋)
    if (globalWss) {
      const resetMessage = `[POWER_TABLE_RESET] ${JSON.stringify({
        action: 'single_page_reset',
        timestamp: new Date().toISOString(),
        message: '단일 페이지 프로세스 시작 - 전압 데이터 초기화'
      })}`;
      
      let sentCount = 0;
      globalWss.clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(resetMessage);
          sentCount++;
        }
      });
      console.log(`[SinglePageProcess] PowerTable 초기화 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
      
      // 초기화 메시지 전송 후 잠시 대기 (클라이언트가 처리할 시간 확보)
      await sleep(2000);
      
      // 초기화 후 빈 테이블 상태를 클라이언트에 전송하여 리셋 확인
      console.log(`[SinglePageProcess] 초기화된 빈 테이블 상태 전송 시작`);
      
      // 전송 전 상태 로깅
      const beforeBroadcast = getCurrentTableData();
      const beforeBroadcastCells = beforeBroadcast.devices.reduce((total, device) => {
        return total + device.tests.reduce((testTotal, test) => {
          return testTotal + test.reads.reduce((readTotal, read) => {
            return readTotal + read.channels.filter(channel => channel.status === 'completed').length;
          }, 0);
        }, 0);
      }, 0);
      console.log(`[SinglePageProcess] 🔍 전송 전 상태 - 완료된 셀: ${beforeBroadcastCells}, Device 1 Test 1 Read 1: ${beforeBroadcast.devices[0]?.tests[0]?.reads[0]?.channels[0]?.voltage || 'null'}`);
      
      await debouncedBroadcastTableData(true);
      console.log(`[SinglePageProcess] 초기화된 빈 테이블 상태 전송 완료`);
    } else {
      console.warn(`[SinglePageProcess] 전역 WebSocket 서버가 설정되지 않음 - PowerTable 초기화 메시지 전송 불가`);
    }
    
    const getTableOption = await getSafeGetTableOption();
    
    // currentTable 변수 정의 - 테이블 데이터 저장용 (채널 1개, Device별 readCount 크기)
    const currentTable = {
      modelName: getTableOption.modelName || 'Unknown Model',
      ProductNumber: getTableOption.ProductNumber || ['Unknown'],
      inputVolt: getTableOption.outVoltSettings || [18, 24, 30],
      reportTable: [{
        TestDate: new Date().toLocaleDateString('en-US'),
        TestTime: new Date().toLocaleTimeString('en-US'),
        TestTemperature: getTableOption.highTempSettings?.targetTemp || 'N/A',
        voltagTable: Array(3).fill(null).map(() => 
          Array(3).fill(null).map(() => // Device 1,2,3
            Array(readCount).fill(null).map(() => 
              Array(1).fill("-.-") // 채널 1개, readCount 크기
            )
          )
        )
      }]
    };
    
    // 딜레이 설정 로드
    const onDelay = getTableOption.delaySettings.onDelay;
    const offDelay = getTableOption.delaySettings.offDelay;
    
    // 3개 input 전압에 대해 각각 readCount만큼 Device 1~3 읽기
    for (let voltageIndex = 0; voltageIndex < 3; voltageIndex++) {
      // 중지 요청 확인 - 전압 테스트 시작 전
      if (getProcessStopRequested()) {
        console.log(`[SinglePageProcess] 🛑 중지 요청 감지 - 전압 테스트 ${voltageIndex + 1}/3에서 중단`);
        return { status: 'stopped', message: '사용자에 의해 중지됨', stoppedAtVoltageTest: voltageIndex + 1, stoppedAtPhase: 'voltage_test_start' };
      }
      
      // 전압 설정
      const inputVolt = getTableOption.outVoltSettings[voltageIndex];
      console.log(`[SinglePageProcess] 전압 ${voltageIndex + 1}/3 설정: ${inputVolt}V`);
      
      // 전압 설정 재시도 로직
      let voltSetSuccess = false;
      let retryCount = 0;
      const maxRetries = 5;
      
      while (!voltSetSuccess && retryCount < maxRetries) {
        // 중지 요청 확인 - 전압 설정 중
        if (getProcessStopRequested()) {
          console.log(`[SinglePageProcess] 🛑 중지 요청 감지 - 전압 설정 중 중단`);
          return { status: 'stopped', message: '사용자에 의해 중단됨', stoppedAtVoltageTest: voltageIndex + 1, stoppedAtPhase: 'voltage_setting' };
        }
        
        try {
          if (getSimulationMode() === false) {
            voltSetSuccess = await SendVoltCommand(inputVolt);
          } else {
            voltSetSuccess = true;
          }

          if (voltSetSuccess === true) {
            console.log(`[SinglePageProcess] 전압 설정 성공: ${inputVolt}V`);
          } else {
            throw new Error('전압 설정 실패: 응답 없음');
          }
        } catch (error) {
          retryCount++;
          console.warn(`[SinglePageProcess] 전압 설정 실패 (${retryCount}/${maxRetries}): ${error}`);
          if (retryCount < maxRetries) {
            console.log(`[SinglePageProcess] 3초 후 재시도...`);
            await sleep(3000);
          } else {
            return { status: 'stopped', message: '전압설정실패', stoppedAtVoltageTest: voltageIndex + 1, stoppedAtPhase: 'before_voltage_setting' };
          }
        }
      }

      if (voltSetSuccess === false) {
        return { status: 'stopped', message: '전압설정실패', stoppedAtVoltageTest: voltageIndex + 1, stoppedAtPhase: 'before_voltage_setting' };
      }
      
      // readCount만큼 Device 1~3 읽기 반복
      for (let readIndex = 0; readIndex < readCount; readIndex++) {
        // 중지 요청 확인
        if (getProcessStopRequested()) {
          console.log(`[SinglePageProcess] 🛑 중지 요청 감지 - readCount ${readIndex + 1}/${readCount}에서 중단`);
          return { 
            status: 'stopped', 
            message: '사용자에 의해 중지됨', 
            stoppedAtRead: readIndex + 1,
            stoppedAtVoltageTest: voltageIndex + 1,
            stoppedAtPhase: 'read_count_loop'
          };
        }
        
        console.log(`[SinglePageProcess] 전압 ${inputVolt}V - readCount ${readIndex + 1}/${readCount} 실행 시작`);
        
        // Device 1~3 읽기
        for (let deviceIndex = 0; deviceIndex < 3; deviceIndex++) {
          // 중지 요청 확인 - 디바이스 처리 시작 전
          if (getProcessStopRequested()) {
            console.log(`[SinglePageProcess] 🛑 중지 요청 감지 - 디바이스 ${deviceIndex + 1}/3에서 중단`);
            return { status: 'stopped', message: '사용자에 의해 중단됨', stoppedAtVoltageTest: voltageIndex + 1, stoppedAtDevice: deviceIndex + 1, stoppedAtPhase: 'device_start' };
          }
            
          if (getTableOption.deviceStates[deviceIndex] === false) {
            currentTable.reportTable[0].voltagTable[voltageIndex][deviceIndex][readIndex][0] = "-.-";
          } else {
            // 디바이스 선택 및 전압 읽기 로직
            const deviceResult = await executeDeviceReading(getTableOption, voltageIndex, deviceIndex, readIndex, inputVolt);
            if (deviceResult.status === 'stopped') {
              return deviceResult;
            }
            currentTable.reportTable[0].voltagTable[voltageIndex][deviceIndex][readIndex][0] = deviceResult.voltageWithComparison;
            
            // 전압 데이터를 테이블에 업데이트 (RunTestProcess.js와 동일한 방식)
            if (deviceResult.voltage && typeof deviceResult.voltage === 'number') {
              updateTableData(deviceIndex + 1, voltageIndex + 1, readIndex + 1, 1, deviceResult.voltage, 'completed');
              console.log(`[SinglePageProcess] Device ${deviceIndex + 1}, Test ${voltageIndex + 1}, Read ${readIndex + 1}: ${deviceResult.voltage}V 테이블 업데이트 완료`);
            } else {
              console.warn(`[SinglePageProcess] Device ${deviceIndex + 1}, Test ${voltageIndex + 1}, Read ${readIndex + 1}: 전압 데이터가 유효하지 않음 - ${deviceResult.voltage}`);
            }
          }
        }
        
        console.log(`[SinglePageProcess] 전압 ${inputVolt}V - readCount ${readIndex + 1}/${readCount} 완료`);
      }
    }
    
    // runSinglePageProcess 완료 시 최종 테이블 데이터 전송 (강제 전송)
    console.log(`[SinglePageProcess] 모든 측정 완료 - 최종 테이블 데이터 전송`);
    await debouncedBroadcastTableData(true);
    
    return { 
      status: 'completed', 
      message: `단일 페이지 프로세스 완료 (${readCount}회 실행)`,
      data: currentTable,
      readCount: readCount
    };
    
  } catch (error) {
    console.error('[SinglePageProcess] 예외 발생:', error);
    
    // 에러 발생 시에도 중단 보고서 생성하지 않음 - 상위 함수에서 처리
    stopInfo = { 
      status: 'error', 
      message: `예외 발생: ${error.message}`,
      errorType: 'exception',
      stoppedAtPhase: 'unknown'
    };
    
    return stopInfo;
  }
}

// 디바이스 읽기 실행 함수 (RunTestProcess.js와 동일)
async function executeDeviceReading(getTableOption, voltageIndex, deviceIndex, readIndex, inputVolt) {
  try {
    const maxRetries = 5;
    let retryCount = 0;
    
    // 딜레이 설정 로드
    const onDelay = (getTableOption.delaySettings.onDelay * 1000);
    const offDelay = (getTableOption.delaySettings.offDelay * 1000);
    
    // 디바이스 선택 재시도 로직
    let deviceSelectSuccess = false;
    
    while (!deviceSelectSuccess && retryCount < maxRetries) {
      // 중지 요청 확인 - 디바이스 선택 중
      if (getProcessStopRequested()) {
        console.log(`[SinglePageProcess] 🛑 중지 요청 감지 - 디바이스 ${deviceIndex + 1} 선택 중 중단`);
        return { status: 'stopped', message: '사용자에 의해 중단됨', stoppedAtVoltageTest: voltageIndex + 1, stoppedAtDevice: deviceIndex + 1, stoppedAtPhase: 'device_selection' };
      }
      
      try {
        // 릴레이 동작 전 정지 신호 확인
        if (getProcessStopRequested()) {
          console.log(`[SinglePageProcess] 🛑 릴레이 동작 전 정지 신호 감지 - 디바이스 ${deviceIndex + 1} 선택 중단`);
          return { status: 'stopped', message: '릴레이 동작 전 정지 신호 감지', stoppedAtVoltageTest: voltageIndex + 1, stoppedAtDevice: deviceIndex + 1, stoppedAtPhase: 'before_relay_operation' };
        }

        let selectResult = true;

        if (getSimulationMode() === false) {
          selectResult = await SelectDeviceOn(deviceIndex + 1);  // 1부터 시작
        }

        if (selectResult === true || selectResult.success === true) {
          deviceSelectSuccess = true;
          await sleep( onDelay );
        } else {
          throw new Error(selectResult?.message || selectResult?.error || '알 수 없는 오류');
        }
      } catch (error) {
        retryCount++;
        console.warn(`[SinglePageProcess] 디바이스 ${deviceIndex + 1} 선택 실패 (${retryCount}/${maxRetries}): ${error}`);
        if (retryCount < maxRetries) {
          console.log(`[SinglePageProcess] 2초 후 재시도...`);
          await sleep(2000);
        } else {
          console.error(`[SinglePageProcess] 디바이스 ${deviceIndex + 1} 선택 최종 실패`);
          return { status: 'stopped', message: '[SinglePageProcess] 디바이스선택 최종 실패', stoppedAtVoltageTest: voltageIndex + 1, stoppedAtDevice: deviceIndex + 1, stoppedAtPhase: 'before_relay_operation' };
        }
      }
    }

    // 전압 읽기 로직
    const channelResults = []; // 배열로 초기화
    
    // 채널 변경을 위한 충분한 시간 확보
    // await sleep(2000);
    
    // 전압 읽기 재시도 로직 (채널 1개만)
    let voltReadSuccess = false;
    let voltData = 0; // voltData 변수를 루프 밖에서 선언
    retryCount = 0;
    
    while (!voltReadSuccess && retryCount < maxRetries) {
      // 중지 요청 확인 - 전압 읽기 중
      if (getProcessStopRequested()) {
        console.log(`[SinglePageProcess] 🛑 중지 요청 감지 - 전압 읽기 중 중단`);
        return { status: 'stopped', message: '사용자에 의해 중단됨', stoppedAtVoltageTest: voltageIndex + 1, stoppedAtDevice: deviceIndex + 1, stoppedAtPhase: 'voltage_reading' };
      }
      
      try {
        if (getSimulationMode() === false) {
          voltData = await ReadVolt(1);     // 채널 하나만 읽는다
        } else {
          // 시뮬레이션 모드에서는 설정된 채널 전압값을 사용하고 약간의 변동 추가
          const baseVoltage = getTableOption.channelVoltages[0];
          let variation = (Math.random() - 0.5) * (baseVoltage * 0.05); // ±5% 변동  
          voltData = baseVoltage + variation; // baseVoltage 5%이내의 변동값 적용
        }
        await sleep(100); // 시뮬레이션을 위한 짧은 대기
        voltReadSuccess = true;
      } catch (error) {
        retryCount++;
        console.warn(`[SinglePageProcess] Device ${deviceIndex + 1}, Channel 1 전압 읽기 실패 (${retryCount}/${maxRetries}): ${error}`);
        if (retryCount < maxRetries) {
          console.log(`[SinglePageProcess] 2초 후 재시도...`);
          await sleep(2000); // 재시도 대기 시간을 2초로 증가
        } else {
          console.error(`[SinglePageProcess] Device ${deviceIndex + 1}, Channel 1 전압 읽기 최종 실패`);
          voltData = 'error';
          return { status: 'stopped', message: '전압 읽기 최종 실패', stoppedAtVoltageTest: voltageIndex + 1, stoppedAtDevice: deviceIndex + 1, stoppedAtChannel: 1, stoppedAtPhase: 'channel_start' };
        }
      }
    }
    
    // 채널 읽기 완료 후 안정화를 위한 추가 대기 시간
    if (voltReadSuccess && voltData !== 'error') {
      await sleep(1000); // 채널 읽기 완료 후 1초 대기
    }
                      
    const expectedVoltage = getTableOption.channelVoltages[0] || 0;
    const comparisonResult = voltData === 'error' ? 'N' : compareVoltage(voltData, expectedVoltage);
     
    // 전압값과 비교 결과를 함께 저장 (예: "221V|G" 또는 "240V|N")
    // 전압값을 소수점 이하로 자르기
    const truncatedVoltData = voltData === 'error' ? voltData : Math.floor(voltData);
    const voltageWithComparison = voltData === 'error' ? 'error|N' : `${truncatedVoltData}V|${comparisonResult}`;
     
    // 채널 결과 수집
    channelResults.push({
      device: deviceIndex + 1,
      channel: 1,
      voltage: voltData,
      expected: expectedVoltage,
      result: comparisonResult,
      voltageWithComparison: voltageWithComparison
    });            
    
    console.log(`[SinglePageProcess] Device ${deviceIndex + 1}, Test ${voltageIndex + 1} 전압 데이터 테이블에 저장`);
    
    // 채널 1개 전압 읽기 완료 후 클라이언트에 실시간 전송 (디바운싱 적용)
    console.log(`[SinglePageProcess] Device ${deviceIndex + 1}, Test ${voltageIndex + 1}: 채널 1개 완료 - 클라이언트에 데이터 전송`);
    
    // TimeMode에서도 개별 측정마다 디바운싱된 전송으로 실시간 업데이트 제공
    // 디바운싱으로 과도한 전송 방지하면서도 실시간성 확보
    await debouncedBroadcastTableData();
    
    // 디바이스 해제 재시도 로직
    retryCount = 0;
    while (retryCount < maxRetries) {
      // 중지 요청 확인 - 디바이스 해제 중
      if (getProcessStopRequested()) {
        console.log(`[SinglePageProcess] 🛑 중지 요청 감지 - 디바이스 ${deviceIndex + 1} 해제 중 중단`);
        // 디바이스 해제는 시도하되 즉시 반환
        try {
          if (getSimulationMode() === false) {
            await SelectDeviceOff(deviceIndex + 1);
          }
        } catch (error) {
          console.warn(`[SinglePageProcess] 디바이스 ${deviceIndex + 1} 해제 실패 (중지 요청으로 인한): ${error}`);
        }
        return { status: 'stopped', message: '사용자에 의해 중단됨', stoppedAtVoltageTest: voltageIndex + 1, stoppedAtDevice: deviceIndex + 1, stoppedAtPhase: 'device_release' };
      }
      
      try {
        if (getSimulationMode() === false) {
          await SelectDeviceOff(deviceIndex + 1);
        }
        break; // 성공하면 루프 종료
      } catch (error) {
        retryCount++;
        console.warn(`[SinglePageProcess] 디바이스 ${deviceIndex + 1} 해제 실패 (${retryCount}/${maxRetries}): ${error}`);
        if (retryCount < maxRetries) {
          console.log(`[SinglePageProcess] 1초 후 재시도...`);
          await sleep(1000);
        } else {
          console.error(`[SinglePageProcess] 디바이스 ${deviceIndex + 1} 해제 최종 실패 - 계속 진행`);
          break; // 해제 실패해도 계속 진행
        }
      }
    }
    
    // 디바이스 해제 후 대기 시간
    await sleep(offDelay);
    
    return { 
      status: 'completed', 
      voltageWithComparison: voltageWithComparison,
      voltage: voltData,
      expected: expectedVoltage,
      result: comparisonResult
    };
    
  } catch (error) {
    console.error(`[SinglePageProcess] executeDeviceReading 예외 발생:`, error);
    return { 
      status: 'error', 
      message: `executeDeviceReading 예외 발생: ${error.message}`,
      errorType: 'exception',
      stoppedAtPhase: 'device_reading'
    };
  }
}


// 중단 보고서 생성을 위한 통일된 함수
async function generateStopReport(stopInfo) {
  try {
    console.log(`[SinglePageProcess] 🛑 중단 보고서 생성 시작: ${stopInfo.status}`);
    
    // 전역 디렉토리명이 있는지 확인
    if (!currentTestDirectoryName) {
      currentTestDirectoryName = getDateDirectoryName();
      console.log(`[SinglePageProcess] ⚠️ 전역 디렉토리명이 없어 새로 생성: ${currentTestDirectoryName}`);
    }
    
    // 테스트 설정 정보 수집
    const getTableOption = await getSafeGetTableOption();
    const testSettings = {
      modelName: getTableOption.productInput?.modelName || 'N/A',
      productNames: getTableOption.productInput?.productNames || ['A-001', 'B-002', 'C-003'],
      temperature: getTableOption.highTempSettings?.targetTemp || 'N/A',
      totalCycles: 1 // 단일 페이지 테스트는 1 사이클
    };
    
    // 중단 보고서 생성
    const reportResult = await generateInterruptedTestResultFile({
      stopReason: stopInfo.errorType || 'user_stop',
      stoppedAtCycle: 1, // 단일 페이지 테스트는 1 사이클
      stoppedAtPhase: stopInfo.stoppedAtPhase || 'unknown',
      errorMessage: stopInfo.message,
      testSettings: testSettings
    });
    
    if (reportResult && reportResult.success) {
      console.log(`[SinglePageProcess] ✅ 중단 보고서 생성 성공: ${reportResult.filename}`);
    } else {
      console.error(`[SinglePageProcess] ❌ 중단 보고서 생성 실패:`, reportResult?.error || '알 수 없는 오류');
    }
    
    // 중단 정보와 함께 반환
    return {
      ...stopInfo,
      finalReportGenerated: reportResult?.success || false,
      reportFilename: reportResult?.filename || null
    };
    
  } catch (reportError) {
    console.error(`[SinglePageProcess] ❌ 중단 보고서 생성 실패:`, reportError.message);
    
    // 보고서 생성 실패 시에도 원래 중단 정보 반환
    return {
      ...stopInfo,
      finalReportGenerated: false,
      reportError: reportError.message
    };
  }
}

// TimeMode 설정을 로드하는 함수
function loadTimeModeSettings() {
  try {
    const settingsPath = path.join(__dirname, 'time_mode_settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    
    // T1~T8 값을 분 단위에서 밀리초로 변환
    const T1 = parseInt(settings.T1) * 60 * 1000; // 분 -> 밀리초
    const T2 = parseInt(settings.T2) * 60 * 1000;
    const T3 = parseInt(settings.T3) * 60 * 1000;
    const T4 = parseInt(settings.T4) * 60 * 1000;
    const T5 = parseInt(settings.T5) * 60 * 1000;
    const T6 = parseInt(settings.T6) * 60 * 1000;
    const T7 = parseInt(settings.T7) * 60 * 1000;
    const T8 = parseInt(settings.T8) * 60 * 1000;
    
    // T_elapsed 배열 계산 (그림의 공식에 따라)
    const T_high1 = T1 + T2;
    const T_low1 = T_high1 + T3 + T4;
    const T_high2 = T_low1 + T5 + T6;
    const T_low2 = T_high2 + T3 + T4;
    const T_end = T_low2 + T5 + T7 + T8;
    
    const T_elapsed = [T_high1, T_low1, T_high2, T_low2];
    
    console.log(`[TimeMode] 시간 설정 로드됨:`);
    console.log(`  T1: ${settings.T1}분, T2: ${settings.T2}분, T3: ${settings.T3}분, T4: ${settings.T4}분`);
    console.log(`  T5: ${settings.T5}분, T6: ${settings.T6}분, T7: ${settings.T7}분, T8: ${settings.T8}분`);
    console.log(`  T_elapsed: [${T_elapsed.map(t => Math.round(t/60000)).join('분, ')}분]`);
    console.log(`  T_end: ${Math.round(T_end/60000)}분`);
    
    return {
      T_elapsed,
      T_end,
      intervals: { T1, T2, T3, T4, T5, T6, T7, T8 }
    };
  } catch (error) {
    console.error(`[TimeMode] 시간 설정 로드 실패:`, error);
    // 기본값 반환
    return {
      T_elapsed: [10*60*1000, 20*60*1000, 30*60*1000, 40*60*1000], // 기본 10, 20, 30, 40분
      T_end: 50*60*1000, // 기본 50분
      intervals: { T1: 5*60*1000, T2: 5*60*1000, T3: 5*60*1000, T4: 5*60*1000, T5: 5*60*1000, T6: 5*60*1000, T7: 5*60*1000, T8: 5*60*1000 }
    };
  }
}

// TimeMode 기반 테스트 실행 함수
export async function runTimeModeTestProcess() {
  try {
    const modeText = getSimulationMode() ? '시뮬레이션 모드' : '실제 모드';
    console.log(`[TimeModeTestProcess] 🔄 TimeMode 테스트 프로세스 시작 (${modeText})`);
    
    // cleanup 후 재시작을 위해 중지 플래그 초기화
    if (getProcessStopRequested()) {
      console.log(`[TimeModeTestProcess] 🔄 cleanup 후 재시작 - 중지 플래그 초기화`);
      setProcessStopRequested(false);
    }
    
    // 전체 테스트 프로세스 시작 시 테이블 데이터 초기화 제거
    // 각 runSinglePageProcess에서 개별적으로 초기화하므로 여기서는 초기화하지 않음
    console.log(`[TimeModeTestProcess] ✅ TimeMode 테스트 프로세스 시작 - 각 단계별 개별 초기화 방식 사용`);
    
    // TIME_PROGRESS 메시지 첫 번째 전송 플래그 초기화 (비활성화됨 - 계속 업데이트 전송)
    // isFirstTimeProgressSent = false;
    // console.log(`[TimeModeTestProcess] ✅ TIME_PROGRESS 첫 번째 전송 플래그 초기화`);
    
    // 테이블 데이터 전송 디바운싱 변수 초기화
    if (tableDataBroadcastTimeout) {
      clearTimeout(tableDataBroadcastTimeout);
      tableDataBroadcastTimeout = null;
    }
    lastTableDataBroadcast = 0;
    console.log(`[TimeModeTestProcess] ✅ 테이블 데이터 전송 디바운싱 변수 초기화`);
    
    // 진행상황 추적 변수 초기화 (runNextTankEnviTestProcess와 동일한 패턴)
    let currentTestStep = 0;
    let totalTestSteps = 4; // TimeMode는 4단계 (HighTemp1, LowTemp1, HighTemp2, LowTemp2)
    let currentTestType = '';
    let currentTestCount = 0;
    let totalTestCount = 0;
    console.log(`[TimeModeTestProcess] ✅ 진행상황 추적 변수 초기화 - 총 ${totalTestSteps}단계`);
    
    // 테스트 시작 알림
    if (globalWss) {
      const testStartMessage = `[TEST_PROGRESS] 테스트 시작 - 시간 모드 테스트 프로세스 (${modeText})`;
      console.log(`[TimeModeTestProcess] 📤 테스트 시작 메시지 전송: ${testStartMessage}`);
      let sentCount = 0;
      globalWss.clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(testStartMessage);
          sentCount++;
        }
      });
      console.log(`[TimeModeTestProcess] 📤 ${sentCount}개 클라이언트에게 메시지 전송 완료`);
    } else {
      console.log(`[TimeModeTestProcess] ❌ globalWss가 null입니다. WebSocket 서버가 설정되지 않았습니다.`);
    }
    
    // 프로세스 시작 전 중지 요청 확인
    if (getProcessStopRequested()) {
      console.log(`[TimeModeTestProcess] 🛑 중지 요청 감지 - 프로세스 시작 전 중단`);
      return { 
        status: 'stopped', 
        message: '사용자에 의해 중지됨', 
        stoppedAtPhase: 'initialization',
        stopReason: 'power_switch_off'
      };
    }
    
    // ===== 디렉토리명을 한 번만 생성하고 전역 변수에 저장 =====
    currentTestDirectoryName = getDateDirectoryName();
    console.log(`[TimeModeTestProcess] 📁 테스트 디렉토리명 생성: ${currentTestDirectoryName}`);
    
    // 테스트 결과 저장을 위한 디렉토리 생성
    const dataFolderPath = path.join(process.cwd(), 'Data');
    if (!fs.existsSync(dataFolderPath)) {
      fs.mkdirSync(dataFolderPath, { recursive: true });
      console.log(`[TimeModeTestProcess] 📁 Data 폴더 생성됨: ${dataFolderPath}`);
    }
    
    const dateFolderPath = path.join(dataFolderPath, currentTestDirectoryName);
    // 전역 변수에 전체 디렉토리 경로 저장
    currentTestDirectoryPath = dateFolderPath;
    // RunTestProcess.js의 전역 변수도 동기화
    setCurrentTestDirectoryPath(dateFolderPath);
    
    if (!fs.existsSync(dateFolderPath)) {
      fs.mkdirSync(dateFolderPath, { recursive: true });
      console.log(`[TimeModeTestProcess] 📁 테스트 결과 저장 디렉토리 생성됨: ${dateFolderPath}`);
      
      if (globalWss) {
        const dirCreateMessage = `[DIRECTORY_CREATED] ${currentTestDirectoryName}`;
        let sentCount = 0;
        globalWss.clients.forEach(client => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(dirCreateMessage);
            sentCount++;
          }
        });
        console.log(`[TimeModeTestProcess] 📤 디렉토리 생성 알림 전송 완료 - 클라이언트 수: ${sentCount}`);
      }
    } else {
      console.log(`[TimeModeTestProcess] 📁 기존 테스트 결과 저장 디렉토리 사용: ${dateFolderPath}`);
    }
    
    // 중지 요청 확인 - 디렉토리 생성 후
    if (getProcessStopRequested()) {
      console.log(`[TimeModeTestProcess] 🛑 중지 요청 감지 - 디렉토리 생성 후 중단`);
      return { 
        status: 'stopped', 
        message: '사용자에 의해 중지됨', 
        stoppedAtPhase: 'directory_creation',
        stopReason: 'power_switch_off'
      };
    }
    
    // TimeMode 설정 로드
    const timeSettings = loadTimeModeSettings();
    const { T_elapsed, T_end } = timeSettings;
    
    // 시뮬레이션 모드에 따른 초기화 처리
    if (getSimulationMode() === false) {
      await RelayAllOff();                      // jsk debug return error 에 대한 처리를 할 것
      await sleep(3000); // 포트 초기화를 위한 추가 대기
    } else {
      // 시뮬레이션 모드일 경우 패스
      console.log('[TimeModeTestProcess] 시뮬레이션 모드: RelayAllOff 및 포트 초기화 대기 패스');
    }
    
    // CtrlTimer 초기화 및 시작
    let CtrlTimer = 0;
    const startTime = Date.now();
    
    console.log(`[TimeModeTestProcess] ⏰ CtrlTimer 시작 - T_end: ${Math.round(T_end/60000)}분`);
    
    // 시간 진행 상황 업데이트 시작
    let timeProgressInterval = startTimeProgressUpdates(startTime, T_end, 'waiting');
    
    // 테스트 설정 정보 수집
    const getTableOption = await getSafeGetTableOption();
    
    // ===== 새로운 구조: 4단계 순차 실행 =====
    const testPhases = [
      { index: 0, type: 'HighTemp', testType: 'HighTemp_Test', readCount: getTableOption.highTempSettings?.readCount || 10 },
      { index: 1, type: 'LowTemp', testType: 'LowTemp_Test', readCount: getTableOption.lowTempSettings?.readCount || 10 },
      { index: 2, type: 'HighTemp', testType: 'HighTemp_Test', readCount: getTableOption.highTempSettings?.readCount || 10 },
      { index: 3, type: 'LowTemp', testType: 'LowTemp_Test', readCount: getTableOption.lowTempSettings?.readCount || 10 }
    ];
    
    // 총 테스트 횟수 계산 (각 단계별 readCount 합계)
    totalTestCount = testPhases.reduce((total, phase) => total + phase.readCount, 0);
    console.log(`[TimeModeTestProcess] 📊 총 테스트 횟수 계산: ${totalTestCount}회 (각 단계별 readCount 합계)`);
    
    // 각 단계별 실행
    for (let phaseIndex = 0; phaseIndex < testPhases.length; phaseIndex++) {
      const phase = testPhases[phaseIndex];
      currentTestStep = phaseIndex + 1;
      currentTestType = phase.type;
      
      // a. 대기 (T_elapsed[phaseIndex] 시간까지)
      console.log(`[TimeModeTestProcess] ⏰ 단계 ${currentTestStep}/${totalTestSteps}: ${currentTestType} 대기 시작 (${Math.round(T_elapsed[phaseIndex]/60000)}분)`);
      
      // 단계별 진행상황 메시지 전송 (runNextTankEnviTestProcess와 동일한 패턴)
      if (globalWss) {
        const stepProgressMessage = `[TEST_PROGRESS_DETAIL] 단계 ${currentTestStep}/${totalTestSteps}: ${currentTestType} 대기 중 (${Math.round(T_elapsed[phaseIndex]/60000)}분)`;
        console.log(`[TimeModeTestProcess] 📤 단계 진행상황 메시지 전송: ${stepProgressMessage}`);
        let sentCount = 0;
        globalWss.clients.forEach(client => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(stepProgressMessage);
            sentCount++;
          }
        });
        console.log(`[TimeModeTestProcess] 📤 ${sentCount}개 클라이언트에게 메시지 전송 완료`);
      }
      
      while (true) {
        // 중지 요청 확인
        if (getProcessStopRequested()) {
          console.log(`[TimeModeTestProcess] 🛑 중지 요청 감지 - ${currentTestType} 대기 중 중단`);
          setMachineRunningStatus(false);
          
          if (timeProgressInterval) {
            clearInterval(timeProgressInterval);
          }
          
          // 파워스위치 OFF 시 진행상황 메시지 초기화 (runNextTankEnviTestProcess와 동일한 패턴)
          if (globalWss) {
            const progressResetMessage = `[TEST_PROGRESS_DETAIL] 진행상황 초기화 - 프로세스 중단됨`;
            const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - Process stopped during ${currentTestType} waiting`;
            globalWss.clients.forEach(client => {
              if (client.readyState === 1) {
                client.send(progressResetMessage);
                client.send(powerOffMessage);
              }
            });
            console.log(`[TimeModeTestProcess] 📤 진행상황 초기화 및 파워스위치 OFF 메시지 전송 완료`);
          }
          
          return { 
            status: 'stopped', 
            message: '사용자에 의해 중지됨', 
            stoppedAtPhase: `${currentTestType.toLowerCase()}_waiting`,
            stopReason: 'power_switch_off'
          };
        }
        
        // 현재 경과 시간 계산
        CtrlTimer = Date.now() - startTime;
        
        // T_elapsed[phaseIndex] 시간이 경과했는지 확인
        if (CtrlTimer > T_elapsed[phaseIndex]) {
          console.log(`[TimeModeTestProcess] ⏰ ${currentTestType} 대기 완료 - 테스트 실행 시작`);
          break;
        }
        
        // 1초 대기
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // 시간 진행 상황 인터벌 정리 (테스트 실행 중에는 업데이트 중단)
      if (timeProgressInterval) {
        clearInterval(timeProgressInterval);
      }
      
      // b. runSinglePageProcess() 호출 및 결과저장
      console.log(`[TimeModeTestProcess] 🔥 ${currentTestType} 테스트 시작 - readCount: ${phase.readCount}`);
      
      // runSinglePageProcess 호출 전 상세 진행상황 메시지 전송 (runNextTankEnviTestProcess와 동일한 패턴)
      if (globalWss) {
        const detailedProgressMessage = `[TEST_PROGRESS_DETAIL] 단계 ${currentTestStep}/${totalTestSteps}: ${currentTestType} 테스트 시작 (${phase.readCount}회 측정)`;
        console.log(`[TimeModeTestProcess] 📤 상세 진행상황 메시지 전송: ${detailedProgressMessage}`);
        let sentCount = 0;
        globalWss.clients.forEach(client => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(detailedProgressMessage);
            sentCount++;
          }
        });
        console.log(`[TimeModeTestProcess] 📤 ${sentCount}개 클라이언트에게 메시지 전송 완료`);
      }
      
      try {
        // runSinglePageProcess() 실행
        const result = await runSinglePageProcess(phase.readCount);
        
        // 성공 여부 확인
        if (!result || result.status !== 'completed') {
          console.log(`[TimeModeTestProcess] ❌ ${currentTestType} 테스트 실패 - generateStopReport() 실행`);
          
          // 테스트 실패 시 진행상황 메시지 초기화 (runNextTankEnviTestProcess와 동일한 패턴)
          if (globalWss) {
            const progressResetMessage = `[TEST_PROGRESS_DETAIL] 진행상황 초기화 - 테스트 실패`;
            globalWss.clients.forEach(client => {
              if (client.readyState === 1) {
                client.send(progressResetMessage);
              }
            });
            console.log(`[TimeModeTestProcess] 📤 테스트 실패로 인한 진행상황 초기화 메시지 전송 완료`);
          }
          
          return await generateStopReport(result);
        }
        
        // 측정 데이터 저장 (RunTestProcess.js 패턴과 동일)
        if (result && result.status === 'completed' && result.data) {
          console.log(`[TimeModeTestProcess] ${currentTestType} 테스트 측정 결과 저장 시작`);
          try {
            const cycleNumber = phaseIndex + 1;
            const saveResult = await saveTotaReportTableToFile(
              result.data, 
              getTableOption.channelVoltages, // RunTestProcess.js와 동일한 패턴 사용
              cycleNumber, 
              phase.testType
            );
            
            if (saveResult && saveResult.success) {
              console.log(`[TimeModeTestProcess] ✅ ${currentTestType} 테스트 측정 데이터 저장 성공: ${saveResult.filename}`);
            } else {
              console.error(`[TimeModeTestProcess] ❌ ${currentTestType} 테스트 측정 데이터 저장 실패:`, saveResult?.error || '알 수 없는 오류');
            }
          } catch (saveError) {
            console.error(`[TimeModeTestProcess] ❌ ${currentTestType} 테스트 측정 데이터 저장 중 오류:`, saveError.message);
          }
        }
        
        console.log(`[TimeModeTestProcess] ✅ ${currentTestType} 테스트 완료`);
        
        // 테스트 완료 시 최종 확인용 테이블 데이터 전송 (강제 전송)
        // runSinglePageProcess에서 이미 개별 전송했지만 최종 확인을 위해 한 번 더 전송
        await debouncedBroadcastTableData(true);
        
      } catch (error) {
        console.error(`[TimeModeTestProcess] ❌ ${currentTestType} 테스트 실행 중 오류:`, error.message);
        
        // 테스트 실행 오류 시 진행상황 메시지 초기화 (runNextTankEnviTestProcess와 동일한 패턴)
        if (globalWss) {
          const progressResetMessage = `[TEST_PROGRESS_DETAIL] 진행상황 초기화 - 테스트 실행 오류`;
          globalWss.clients.forEach(client => {
            if (client.readyState === 1) {
              client.send(progressResetMessage);
            }
          });
          console.log(`[TimeModeTestProcess] 📤 테스트 실행 오류로 인한 진행상황 초기화 메시지 전송 완료`);
        }
        
        return { 
          status: 'error', 
          message: `${currentTestType} 테스트 실행 중 오류: ${error.message}`,
          errorType: 'test_execution_error',
          stoppedAtPhase: `${currentTestType.toLowerCase()}_test_execution`
        };
      }
      
      // 다음 단계 대기 시간 - 시간 진행 상황 업데이트 제거 (클라이언트 테이블 깜박임 방지)
      if (phaseIndex < testPhases.length - 1) {
        const nextWaitTime = T_elapsed[phaseIndex + 1] - T_elapsed[phaseIndex];
        console.log(`[TimeModeTestProcess] ⏰ 다음 단계 대기 시작 - ${Math.round(nextWaitTime/60000)}분 후 실행 (시간 진행 상황 업데이트 생략)`);
        // timeProgressInterval = startTimeProgressUpdates(Date.now(), remainingTime, 'waiting'); // 제거됨
      }
    }
    
    // i. 최종 보고서 생성 (FinalReportGenerator 로직 사용)
    console.log(`[TimeModeTestProcess] 📄 모든 테스트 단계 완료 - 최종 디바이스 리포트 생성`);
    try {
      const finalReportResult = await generateFinalReportFromDirectory(
        currentTestDirectoryPath || path.join(process.cwd(), 'Data', 'default'), 
        currentTestDirectoryName || 'default'
      );
      if (finalReportResult && finalReportResult.success) {
        console.log(`[TimeModeTestProcess] ✅ 최종 디바이스 리포트 생성 성공: ${finalReportResult.filename}`);
      } else {
        console.error(`[TimeModeTestProcess] ❌ 최종 디바이스 리포트 생성 실패:`, finalReportResult?.error || '알 수 없는 오류');
      }
    } catch (error) {
      console.error(`[TimeModeTestProcess] ❌ 최종 디바이스 리포트 생성 실패:`, error.message);
    }
    
    // j. T_end 시간까지 대기 후 종료
    console.log(`[TimeModeTestProcess] ⏰ T_end 시간까지 대기 (${Math.round(T_end/60000)}분)`);
    
    // 대기 시작 알림
    if (globalWss) {
      const waitStartMessage = `[TEST_PROGRESS] 모든 측정 완료 - T_end 시간까지 대기 중 (${Math.round(T_end/60000)}분)`;
      globalWss.clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(waitStartMessage);
        }
      });
    }
    
    while (CtrlTimer < T_end) {
      // 중지 요청 확인
      if (getProcessStopRequested()) {
        console.log(`[TimeModeTestProcess] 🛑 중지 요청 감지 - T_end 대기 중 중단`);
        setMachineRunningStatus(false);
        
        // 파워스위치 OFF 시 진행상황 메시지 초기화 (runNextTankEnviTestProcess와 동일한 패턴)
        if (globalWss) {
          const progressResetMessage = `[TEST_PROGRESS_DETAIL] 진행상황 초기화 - 프로세스 중단됨`;
          const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - Process stopped during T_end waiting`;
          globalWss.clients.forEach(client => {
            if (client.readyState === 1) {
              client.send(progressResetMessage);
              client.send(powerOffMessage);
            }
          });
          console.log(`[TimeModeTestProcess] 📤 진행상황 초기화 및 파워스위치 OFF 메시지 전송 완료`);
        }
        
        return { 
          status: 'stopped', 
          message: '사용자에 의해 중지됨', 
          stoppedAtPhase: 't_end_waiting',
          stopReason: 'power_switch_off'
        };
      }
      
      // 현재 경과 시간 업데이트
      CtrlTimer = Date.now() - startTime;
      
      // 아직 T_end에 도달하지 않았으면 잠시 대기
      if (CtrlTimer < T_end) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1초 대기
      }
    }
    
    // PowerSwitch 상태 OFF 설정
    setMachineRunningStatus(false);
    
    // 클라이언트에게 파워스위치 OFF 상태 전송 및 진행상황 초기화 (runNextTankEnviTestProcess와 동일한 패턴)
    if (globalWss) {
      const progressResetMessage = `[TEST_PROGRESS_DETAIL] 진행상황 초기화 - 테스트 완료`;
      const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - Test completed`;
      globalWss.clients.forEach(client => {
        if (client.readyState === 1) {
          client.send(progressResetMessage);
          client.send(powerOffMessage);
        }
      });
      console.log(`[TimeModeTestProcess] 📤 진행상황 초기화 및 파워스위치 OFF 메시지 전송 완료`);
    }
    
    console.log(`[TimeModeTestProcess] 🛑 프로세스 완료 - 중지 플래그 상태 유지`);
    
    // 프로세스 완료 후 전역 디렉토리명 초기화 (모든 파일 생성 완료 후)
    console.log(`[TimeModeTestProcess] 📁 프로세스 완료 - 전역 디렉토리명 초기화: ${currentTestDirectoryName}`);
    currentTestDirectoryName = null;
    
    // 테스트 완료 알림
    if (globalWss) {
      const testCompleteMessage = `[TEST_COMPLETED] 시간 모드 테스트 프로세스 완료 - 총 ${totalTestSteps}개 단계 완료`;
      const testCompleteData = {
        type: 'TEST_COMPLETED',
        testType: '시간 모드 테스트',
        cycleCount: totalTestSteps,
        completionTime: new Date().toISOString(),
        status: 'success'
      };
      
      globalWss.clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(testCompleteMessage);
          client.send(`[TEST_COMPLETE_DATA] ${JSON.stringify(testCompleteData)}`);
        }
      });
      console.log(`[TimeModeTestProcess] 🎉 테스트 완료 알림 메시지 전송 완료 - 클라이언트 수: ${globalWss.clients.size}`);
    } else {
      console.warn(`[TimeModeTestProcess] 전역 WebSocket 서버가 설정되지 않음 - 테스트 완료 알림 메시지 전송 불가`);
    }
    
    return { 
      status: 'completed', 
      message: '모든 테스트 단계 완료 및 최종 디바이스 리포트 생성 완료',
      totalSteps: totalTestSteps, // 동적으로 계산된 단계 수
      finalReportGenerated: true
    };
    
  } catch (error) {
    console.error(`[TimeModeTestProcess] ❌ 오류 발생:`, error);
    setMachineRunningStatus(false);
    
    // 에러 발생 시에도 클라이언트에게 알림 및 진행상황 초기화 (runNextTankEnviTestProcess와 동일한 패턴)
    if (globalWss) {
      const progressResetMessage = `[TEST_PROGRESS_DETAIL] 진행상황 초기화 - 프로세스 오류`;
      const errorMessage = `[TEST_ERROR] 시간 모드 테스트 프로세스 오류: ${error.message}`;
      globalWss.clients.forEach(client => {
        if (client.readyState === 1) {
          client.send(progressResetMessage);
          client.send(errorMessage);
        }
      });
      console.log(`[TimeModeTestProcess] 📤 진행상황 초기화 및 오류 메시지 전송 완료`);
    }
    
    return {
      status: 'error',
      message: `TimeMode 테스트 프로세스 오류: ${error.message}`,
      error: error,
      errorType: 'process_error'
    };
  }
}

export async function runNextTankEnviTestProcess() {
  try {
    const modeText = getSimulationMode() ? '시뮬레이션 모드' : '실제 모드';
    console.log(`[NextTankEnviTestProcess] 🔄 환경 테스트 프로세스 시작 (${modeText})`);
    
    // cleanup 후 재시작을 위해 중지 플래그 초기화
    if (getProcessStopRequested()) {
      console.log(`[NextTankEnviTestProcess] 🔄 cleanup 후 재시작 - 중지 플래그 초기화`);
      setProcessStopRequested(false);
    }
    
    // 전체 테스트 프로세스 시작 시 테이블 데이터 초기화 (한 번만)
    resetTableData();
    console.log(`[NextTankEnviTestProcess] ✅ 테이블 데이터 초기화 완료`);
    
    // 초기화 후 즉시 빈 테이블을 클라이언트에 전송하여 테이블 리셋 표시
    await debouncedBroadcastTableData(true);
    console.log(`[NextTankEnviTestProcess] ✅ 초기화된 빈 테이블 전송 완료`);
    
    // 테이블 데이터 전송 디바운싱 변수 초기화
    if (tableDataBroadcastTimeout) {
      clearTimeout(tableDataBroadcastTimeout);
      tableDataBroadcastTimeout = null;
    }
    lastTableDataBroadcast = 0;
    console.log(`[NextTankEnviTestProcess] ✅ 테이블 데이터 전송 디바운싱 변수 초기화`);
    
    // 프로세스 시작 전 중지 요청 확인
    if (getProcessStopRequested()) {
      console.log(`[NextTankEnviTestProcess] 🛑 중지 요청 감지 - 프로세스 시작 전 중단`);
      return { 
        status: 'stopped', 
        message: '사용자에 의해 중지됨', 
        stoppedAtPhase: 'initialization',
        stopReason: 'power_switch_off'
      };
    }
    
    // ===== 디렉토리명을 한 번만 생성하고 전역 변수에 저장 =====
    currentTestDirectoryName = getDateDirectoryName();
    console.log(`[NextTankEnviTestProcess] 📁 테스트 디렉토리명 생성: ${currentTestDirectoryName}`);
    
    // 테스트 결과 저장을 위한 디렉토리 생성
    const dataFolderPath = path.join(process.cwd(), 'Data');
    if (!fs.existsSync(dataFolderPath)) {
      fs.mkdirSync(dataFolderPath, { recursive: true });
      console.log(`[NextTankEnviTestProcess] 📁 Data 폴더 생성됨: ${dataFolderPath}`);
    }
    
    const dateFolderPath = path.join(dataFolderPath, currentTestDirectoryName);
    // 전역 변수에 전체 디렉토리 경로 저장
    currentTestDirectoryPath = dateFolderPath;
    // RunTestProcess.js의 전역 변수도 동기화
    setCurrentTestDirectoryPath(dateFolderPath);
    
    if (!fs.existsSync(dateFolderPath)) {
      fs.mkdirSync(dateFolderPath, { recursive: true });
      console.log(`[NextTankEnviTestProcess] 📁 테스트 결과 저장 디렉토리 생성됨: ${dateFolderPath}`);
      
      if (globalWss) {
        const dirCreateMessage = `[DIRECTORY_CREATED] ${currentTestDirectoryName}`;
        let sentCount = 0;
        globalWss.clients.forEach(client => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(dirCreateMessage);
            sentCount++;
          }
        });
        console.log(`[NextTankEnviTestProcess] 📤 디렉토리 생성 알림 전송 완료 - 클라이언트 수: ${sentCount}`);
      }
    } else {
      console.log(`[NextTankEnviTestProcess] 📁 기존 테스트 결과 저장 디렉토리 사용: ${dateFolderPath}`);
    }
    
    // 중지 요청 확인 - 디렉토리 생성 후
    if (getProcessStopRequested()) {
      console.log(`[NextTankEnviTestProcess] 🛑 중지 요청 감지 - 디렉토리 생성 후 중단`);
      return { 
        status: 'stopped', 
        message: '사용자에 의해 중지됨', 
        stoppedAtPhase: 'directory_creation',
        stopReason: 'power_switch_off'
      };
    }
    
    // 테스트 설정 확인
    const getTableOption = await getSafeGetTableOption();
    const highTempEnabled = getTableOption.highTempSettings.highTemp;
    const lowTempEnabled = getTableOption.lowTempSettings.lowTemp;
    
    if (!highTempEnabled && !lowTempEnabled) {
      console.error(`[NextTankEnviTestProcess] ❌ 고온/저온 테스트가 모두 비활성화되어 있습니다.`);
      setMachineRunningStatus(false);
      return { 
        status: 'error', 
        message: '테스트가 비활성화됨 - 고온/저온 테스트 설정을 확인하세요',
        errorType: 'no_tests_enabled'
      };
    }
    // cycleNumber 횟수만큼 반복
    const cycleNumber = getTableOption.delaySettings.cycleNumber || 1; // 기본값 1

    if( getSimulationMode() === false ){
      await RelayAllOff();                      // jsk debug return error 에 대한 처리를 할 것
      await sleep(3000); // 포트 초기화를 위한 추가 대기
    } else {
      // 시뮬레이션 모드일 경우 패스
      console.log('시뮬레이션 모드: RelayAllOff 및 포트 초기화 대기 패스');
    }

    for (let cycle = 1; cycle <= cycleNumber; cycle++) {
      // 중지 요청 확인 - 사이클 시작 전
      // 단순한 중지 확인 - 사이클 시작 전
      if (getProcessStopRequested()) {
        console.log(`[NextTankEnviTestProcess] 🛑 중지 요청 감지 - 사이클 ${cycle}에서 프로세스 중단`);
        return { 
          status: 'stopped', 
          message: '사용자에 의한 파워스위치 OFF',
          stoppedAtCycle: cycle,
          stopReason: 'power_switch_off'
        };
      }
      
      console.log(`[NextTankEnviTestProcess] === 사이클 ${cycle}/${cycleNumber} 시작 ===`);
      
      // 각 사이클 시작 시 PowerTable 초기화 메시지 제거 (테이블 깜박임 방지)
      console.log(`[NextTankEnviTestProcess] 사이클 ${cycle} 시작 - PowerTable 초기화 메시지 전송 생략 (테이블 깜박임 방지)`);
      
      // 사이클별 결과 저장용 변수
      let highTempResults = [];
      let lowTempResults = [];
      
      // high temp test
      const highTemp = getTableOption.highTempSettings.targetTemp;
      const waitTime = getTableOption.highTempSettings.waitTime; // 분 단위로 저장된 값
      const highTempTest = getTableOption.highTempSettings.highTemp;
      const readCount = getTableOption.highTempSettings.readCount;

      if(highTempTest === true) {
        console.log(`[NextTankEnviTestProcess] 사이클 ${cycle}: 1. 고온 테스트 시작`);
        
        // 고온 테스트 시작 시 간단한 테스트 시작 메시지 전송 (테이블 리셋 방지)
        if (globalWss) {
          const highTempStartMessage = `[TEST_PROGRESS] 사이클 ${cycle}: 고온 테스트 시작 (${readCount}회)`;
          
          let sentCount = 0;
          globalWss.clients.forEach(client => {
            if (client.readyState === 1) { // WebSocket.OPEN
              client.send(highTempStartMessage);
              sentCount++;
            }
          });
          console.log(`[NextTankEnviTestProcess] 사이클 ${cycle} 고온 테스트 시작 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
        }
        
        // 챔버 온도를 읽어서 비교하여 도달하면 테스트 시작
        // 아니면 온도가 도달 할때 까지 대기
        // 온도 대기 중 중지 요청 확인을 위한 간격 - 더 빠른 응답을 위해 1초로 단축
        const tempCheckInterval = 1000; // 1초마다 중지 요청 확인
        let lastTempCheck = Date.now();
        
        // 온도 대기 시작 시간 기록
        const tempWaitStartTime = Date.now();
        const estimatedTempWaitTime = 30 * 60 * 1000; // 30분 예상 대기 시간
        console.log('🔒 TIME_PROGRESS sending skipped - client using local calculation');
        // 시간 진행 상황 업데이트는 클라이언트에서 로컬 계산으로 처리
        
        while(true) {
          // 중지 요청 확인 - 온도 대기 중
          if (getProcessStopRequested()) {
            console.log(`[NextTankEnviTestProcess] 🛑 중지 요청 감지 - 고온 테스트 온도 대기 중 중단`);
            
            // 온도 대기 진행 상황 인터벌 정리 (이미 제거됨)
            
            // PowerSwitch 상태 OFF 설정
            setMachineRunningStatus(false);
            
            // 클라이언트에게 파워스위치 OFF 상태 전송
            if (globalWss) {
              const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - Process stopped during high temp waiting`;
              globalWss.clients.forEach(client => {
                if (client.readyState === 1) {
                  client.send(powerOffMessage);
                }
              });
            }
            
                          // 중단 보고서 생성은 최종 종료 시에만 생성하도록 수정
              console.log(`[NextTankEnviTestProcess] 📄 중단 보고서는 최종 종료 시에 생성됩니다.`);
            
            // 프로세스 중지 플래그 초기화 제거 - 중지 상태 유지
            console.log(`[NextTankEnviTestProcess] 🛑 프로세스 중지 상태 유지 - 고온 테스트 온도 대기 중`);
            // setProcessStopRequested(false) 호출 제거
            
            return { 
              status: 'stopped', 
              message: '사용자에 의해 중지됨', 
              stoppedAtCycle: cycle, 
              stoppedAtPhase: 'high_temp_waiting',
              totalCycles: cycle
            };
          }
          
          // 온도 대기 중 중지 요청 확인을 위한 간격 체크
          const now = Date.now();
          if (now - lastTempCheck >= tempCheckInterval) {
            lastTempCheck = now;
            
            // 중지 요청 확인 - 온도 대기 중 주기적 체크
            if (getProcessStopRequested()) {
              console.log(`[NextTankEnviTestProcess] 🛑 중지 요청 감지 - 고온 테스트 온도 대기 중 주기적 체크에서 중단`);
              
              // 온도 대기 진행 상황 인터벌 정리
              if (tempWaitProgressInterval) {
                clearInterval(tempWaitProgressInterval);
              }
              
              // PowerSwitch 상태 OFF 설정
              setMachineRunningStatus(false);
              
              // 클라이언트에게 파워스위치 OFF 상태 전송
              if (globalWss) {
                const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - Process stopped during high temp waiting`;
                globalWss.clients.forEach(client => {
                  if (client.readyState === 1) {
                    client.send(powerOffMessage);
                  }
                });
              }
              
              // 중단 보고서 생성은 최종 종료 시에만 생성하도록 수정
              console.log(`[NextTankEnviTestProcess] 📄 중단 보고서는 최종 종료 시에 생성됩니다.`);
              
              // 프로세스 중지 플래그 초기화 제거 - 중지 상태 유지
              console.log(`[NextTankEnviTestProcess] 🛑 프로세스 중지 상태 유지 - 고온 테스트 온도 대기 중 주기적 체크`);
              // setProcessStopRequested(false) 호출 제거
              
              return { 
                status: 'stopped', 
                message: '사용자에 의해 중지됨', 
                stoppedAtCycle: cycle, 
                stoppedAtPhase: 'high_temp_waiting',
                totalCycles: cycle
              };
            }
          }
          
          let chamberTemp = 23.45;
          if( getSimulationMode() === false ){
            console.log(`[NextTankEnviTestProcess] 사이클 ${cycle}: 고온 테스트 대기 중 온도 읽기`);
            chamberTemp = await getCurrentChamberTemperature();
          }
          
          // ReadChamber 실패 시 처리
          if (chamberTemp === false) {
            console.error(`[NextTankEnviTestProcess] 🛑 챔버 온도 읽기 실패 - 사이클 ${cycle}에서 프로세스 중단`);
            
            // PowerSwitch 상태를 off로 설정
            setMachineRunningStatus(false);
            console.log(`[NextTankEnviTestProcess] 🔌 챔버 오류로 인한 PowerSwitch 상태 OFF 설정`);
            
            // 클라이언트에게 파워스위치 OFF 상태 전송
            if (globalWss) {
              const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - Chamber read failed`;
              let sentCount = 0;
              globalWss.clients.forEach(client => {
                if (client.readyState === 1) { // WebSocket.OPEN
                  client.send(powerOffMessage);
                  sentCount++;
                }
              });
              //console.log(`[NextTankEnviTestProcess] 🔌 챔버 오류로 인한 파워스위치 OFF 상태 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
            } else {
              console.warn(`[NextTankEnviTestProcess] 전역 WebSocket 서버가 설정되지 않음 - 챔버 오류 시 파워스위치 OFF 메시지 전송 불가`);
            }
            
            // 중단된 테스트 결과 파일 생성
            console.log(`[NextTankEnviTestProcess] 📄 중단된 테스트 결과 파일 생성 시작...`);
            
            try {
              // 생성된 파일들을 찾기 위해 Data 폴더 스캔
              const dataFolderPath = path.join(process.cwd(), 'Data');
              // 전역 변수에서 테스트 디렉토리명 사용
              let dateDirectoryName = currentTestDirectoryName || getDateDirectoryName();
              const dateFolderPath = path.join(dataFolderPath, dateDirectoryName);
              
              let existingFiles = [];
              if (fs.existsSync(dateFolderPath)) {
                const files = fs.readdirSync(dateFolderPath);
                existingFiles = files
                  .filter(file => file.endsWith('.csv'))
                  .map(file => path.join(dateFolderPath, file));
              }
              
              // 테스트 설정 정보 수집
              const testSettings = {
                modelName: getTableOption.productInput?.modelName || 'N/A',
                productNames: getTableOption.productInput?.productNames || ['A-001', 'B-002', 'C-003'],
                temperature: getTableOption.highTempSettings?.targetTemp || 'N/A',
                highTempEnabled: getTableOption.highTempSettings?.highTemp || false,
                lowTempEnabled: getTableOption.lowTempSettings?.lowTemp || false,
                totalCycles: cycleNumber,
                highTempWaitTime: getTableOption.highTempSettings?.waitTime || 'N/A',
                lowTempWaitTime: getTableOption.lowTempSettings?.waitTime || 'N/A',
                highTempReadCount: getTableOption.highTempSettings?.readCount || 'N/A',
                lowTempReadCount: getTableOption.lowTempSettings?.readCount || 'N/A'
              };
              
              // 중단된 테스트 결과 파일 생성
              const result = await generateInterruptedTestResultFile({
                stopReason: 'system_failure',
                stoppedAtCycle: cycle,
                stoppedAtPhase: 'high_temp_waiting',
                errorMessage: '챔버 온도 읽기 실패 - 장비 연결 상태를 확인하세요',
                testSettings
              });
              
              if (result.success) {
                console.log(`[NextTankEnviTestProcess] ✅ 중단된 테스트 결과 파일 생성 완료: ${result.filename}`);
              } else {
                console.error(`[NextTankEnviTestProcess] ❌ 중단된 테스트 결과 파일 생성 실패: ${result.error}`);
              }
            } catch (fileError) {
              console.error(`[NextTankEnviTestProcess] 중단된 테스트 결과 파일 생성 중 오류:`, fileError);
            }

            return { 
              status: 'error', 
              message: '챔버 온도 읽기 실패 - 장비 연결 상태를 확인하세요', 
              stoppedAtCycle: cycle, 
              errorType: 'chamber_read_failed' 
            };
          }
          
          if(chamberTemp >= highTemp) {
            console.log(`[NextTankEnviTestProcess] 사이클 ${cycle}: 고온 테스트 시작 (${chamberTemp}°C)`);
            
            // 온도 대기 진행 상황 인터벌 정리 (이미 제거됨)
            
            // waitTime 분 만큼 대기 (중지 요청 확인 가능)
            if(getSimulationMode() === false){
              console.log(`[NextTankEnviTestProcess] 고온 도달 후 ${waitTime}분 대기 시작...`);
              try {
                await sleepMinutesWithStopCheck(waitTime, `사이클 ${cycle} 고온 대기`);
              } catch (error) {
                if (error.message === 'PROCESS_STOP_REQUESTED') {
                  console.log(`[NextTankEnviTestProcess] 🛑 중지 요청 감지 - 고온 대기 중 중단`);
                  
                  // 중지 시에도 PowerSwitch 상태를 off로 설정
                  setMachineRunningStatus(false);
                  console.log(`[NextTankEnviTestProcess] 🔌 중지로 인한 PowerSwitch 상태 OFF 설정`);
                  
                  // 클라이언트에게 파워스위치 OFF 상태 전송
                  if (globalWss) {
                    const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - High temp waiting stopped`;
                    let sentCount = 0;
                    globalWss.clients.forEach(client => {
                      if (client.readyState === 1) { // WebSocket.OPEN
                        client.send(powerOffMessage);
                        sentCount++;
                      }
                    });
                    console.log(`[NextTankEnviTestProcess] 🔌 고온 대기 중단으로 인한 파워스위치 OFF 상태 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
                  } else {
                    console.warn(`[NextTankEnviTestProcess] 전역 WebSocket 서버가 설정되지 않음 - 고온 대기 중단 시 파워스위치 OFF 메시지 전송 불가`);
                  }
                  
                  return { 
                    status: 'stopped', 
                    message: '사용자에 의해 중지됨', 
                    stoppedAtCycle: cycle, 
                    stoppedAtPhase: 'high_temp_waiting',
                    totalCycles: cycle
                  };
                } else {
                  throw error; // 다른 에러는 다시 던짐
                }
              }
            }
            
            // runSinglePageProcess 를 readCount 만큼 실행
            for(let i = 0; i < readCount; i++) {
              // 중지 요청 확인
              if (getProcessStopRequested()) {
                console.log(`[NextTankEnviTestProcess] 🛑 중지 요청 감지 - 고온 테스트 실행 중 중단 (${i+1}/${readCount})`);
                
                // 중지 시에도 PowerSwitch 상태를 off로 설정
                setMachineRunningStatus(false);
                console.log(`[NextTankEnviTestProcess] 🔌 중지로 인한 PowerSwitch 상태 OFF 설정`);
                
                // 클라이언트에게 파워스위치 OFF 상태 전송
                if (globalWss) {
                  const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - High temp test execution stopped`;
                  let sentCount = 0;
                  globalWss.clients.forEach(client => {
                    if (client.readyState === 1) { // WebSocket.OPEN
                      client.send(powerOffMessage);
                      sentCount++;
                    }
                  });
                  console.log(`[NextTankEnviTestProcess] 🔌 고온 테스트 실행 중단으로 인한 파워스위치 OFF 상태 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
                } else {
                  console.warn(`[NextTankEnviTestProcess] 전역 WebSocket 서버가 설정되지 않음 - 고온 테스트 실행 중단 시 파워스위치 OFF 메시지 전송 불가`);
                }
                
                // 중단 보고서 생성은 최종 종료 시에만 생성하도록 수정
                console.log(`[NextTankEnviTestProcess] 📄 중단 보고서는 최종 종료 시에 생성됩니다.`);
                
                return { 
                  status: 'stopped', 
                  message: '사용자에 의해 중단됨', 
                  stoppedAtCycle: cycle, 
                  stoppedAtPhase: 'high_temp_test', 
                  stoppedAtTest: i+1,
                  totalCycles: cycle
                };
              }
              
              console.log(`[NextTankEnviTestProcess] 사이클 ${cycle}: 고온 테스트 ${i+1}/${readCount} 실행`);
              
              // 현재 테스트 번호를 간단한 진행 상황 메시지로 업데이트 (테이블 리셋 방지)
              if (globalWss) {
                const testProgressMessage = `[TEST_PROGRESS] 사이클 ${cycle}: 고온 테스트 ${i+1}/${readCount} 실행 중`;
                
                let sentCount = 0;
                globalWss.clients.forEach(client => {
                  if (client.readyState === 1) { // WebSocket.OPEN
                    client.send(testProgressMessage);
                    sentCount++;
                  }
                });
                console.log(`[NextTankEnviTestProcess] 사이클 ${cycle} 고온 테스트 ${i+1}/${readCount} 진행 상황 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
              }
              
              // SinglePageProcess 재시도 로직 (최대 5회)
              let singlePageSuccess = false;
              let retryCount = 0;
              const maxRetries = 5;
              let singlePageResult = null;
              
              while (!singlePageSuccess && retryCount < maxRetries) {
                try {
                  singlePageResult = await runSinglePageProcess(readCount);
                  
                  if ( singlePageResult.status === 'stopped') {
                    console.log(`[NextTankEnviTestProcess] 🛑 SinglePageProcess 중지됨: ${singlePageResult.message}`);
                    console.log(`[NextTankEnviTestProcess] 🛑 SinglePageProcess 중지로 인한 중단 보고서 생성`);
                    // PowerSwitch 상태를 off로 설정
                    setMachineRunningStatus(false);
                    
                    // 클라이언트에게 파워스위치 OFF 상태 전송
                    if (globalWss) {
                      const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - SinglePageProcess stopped`;
                      let sentCount = 0;
                      globalWss.clients.forEach(client => {
                        if (client.readyState === 1) { // WebSocket.OPEN
                          client.send(powerOffMessage);
                          sentCount++;
                        }
                      });
                      console.log(`[NextTankEnviTestProcess] 🔌 SinglePageProcess 중지로 인한 파워스위치 OFF 상태 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
                    }
                    
                    // 중단 보고서는 최종 종료 시에만 생성하도록 수정
                    console.log(`[NextTankEnviTestProcess] 📄 중단 보고서는 최종 종료 시에 생성됩니다.`);
                    
                    // 전역 디렉토리명 초기화
                    currentTestDirectoryName = null;
                    
                    // 중단 상태로 프로세스 완료
                                      return {
                    status: 'stopped',
                    message: 'SinglePageProcess 중지로 인한 전체 프로세스 중단',
                    stoppedAtCycle: cycle,
                    stoppedAtPhase: 'high_temp_test',
                    stopReason: 'SinglePageProcess_stopped',
                    finalReportGenerated: true,
                    totalCycles: cycle
                  };
                  }
                  
                  if (singlePageResult && singlePageResult.status === 'completed' && singlePageResult.data) {
                    singlePageSuccess = true;
                    console.log(`[NextTankEnviTestProcess] 사이클 ${cycle} 고온 테스트 ${i+1}/${readCount} 성공 (${retryCount + 1}번째 시도)`);
                  } else {
                    throw new Error(`SinglePageProcess 실패: ${singlePageResult?.message || '알 수 없는 오류'}`);
                  }
                } catch (error) {
                  retryCount++;
                  console.warn(`[NextTankEnviTestProcess] 사이클 ${cycle} 고온 테스트 ${i+1}/${readCount} 실패 (${retryCount}/${maxRetries}): ${error.message}`);
                  
                  if (retryCount < maxRetries) {
                    console.log(`[NextTankEnviTestProcess] 3초 후 재시도...`);
                    await sleep(3000);
                  } else {
                    console.error(`[NextTankEnviTestProcess] 사이클 ${cycle} 고온 테스트 ${i+1}/${readCount} 최종 실패 - 프로세스 중단`);
                    
                    // PowerSwitch 상태를 off로 설정
                    setMachineRunningStatus(false);
                    console.log(`[NextTankEnviTestProcess] 🔌 고온 테스트 실패로 인한 PowerSwitch 상태 OFF 설정`);
                    
                                        // 중단 보고서는 최종 종료 시에만 생성하도록 수정
                    console.log(`[NextTankEnviTestProcess] 📄 중단 보고서는 최종 종료 시에 생성됩니다.`);
                    
                    // 전역 디렉토리명 초기화
                    currentTestDirectoryName = null;
                    
                    return { 
                      status: 'error', 
                      message: `고온 테스트 ${i+1}/${readCount} 실패 - 5회 재시도 후 최종 실패`, 
                      stoppedAtCycle: cycle, 
                      stoppedAtPhase: 'high_temp_test', 
                      stoppedAtTest: i+1,
                      errorType: 'high_temp_test_failed',
                      finalReportGenerated: true
                    };
                  }
                }
              }
              
              // 각 실행 결과를 개별 파일로 저장
              if (singlePageResult && singlePageResult.status === 'completed' && singlePageResult.data) {
                console.log(`[NextTankEnviTestProcess] 사이클 ${cycle} 고온 테스트 ${i+1}/${readCount} 결과 저장 시작`);
                const saveResult = await saveTotaReportTableToFile(
                  singlePageResult.data, 
                  getTableOption.channelVoltages, 
                  cycle, 
                  `HighTemp_Test${i+1}`
                );
                if (saveResult.success) {
                  console.log(`[NextTankEnviTestProcess] 사이클 ${cycle} 고온 테스트 ${i+1}/${readCount} 결과 저장 완료: ${saveResult.filename}`);
                } else {
                  console.error(`[NextTankEnviTestProcess] 사이클 ${cycle} 고온 테스트 ${i+1}/${readCount} 결과 저장 실패: ${saveResult.error}`);
                }
                
                // 결과 누적 (기존 로직 유지)
                highTempResults.push(singlePageResult.data);
              }
            }
            console.log(`[NextTankEnviTestProcess] 사이클 ${cycle}: 고온 테스트 완료 (${highTempResults.length}개 결과 누적)`);
            
            // 실행완료 하면 빠져 나감
            break;
          } else {
            console.log(`[NextTankEnviTestProcess] 사이클 ${cycle}: 고온 대기 중... 현재: ${chamberTemp}°C, 목표: ${highTemp}°C`);
            await sleep(60000); // 1분 대기
          }
        }
      }
      
      // low temp test
      const lowTemp = getTableOption.lowTempSettings.targetTemp;
      const lowWaitTime = getTableOption.lowTempSettings.waitTime; // 분 단위로 저장된 값
      const lowTempTest = getTableOption.lowTempSettings.lowTemp;
      const lowReadCount = getTableOption.lowTempSettings.readCount;
      //console.log(`[NextTankEnviTestProcess] lowTemp: ${lowTemp}`);
      //console.log(`[NextTankEnviTestProcess] lowWaitTime: ${lowWaitTime}분`);
      //console.log(`[NextTankEnviTestProcess] lowReadCount: ${lowReadCount}`); 
      //console.log(`[NextTankEnviTestProcess] lowTempTest: ${lowTempTest}`);
      
      if(lowTempTest === true) {
        console.log(`[NextTankEnviTestProcess] 사이클 ${cycle}: 2. 저온 테스트 시작`); 
        
        // 저온 테스트 시작 시 간단한 테스트 시작 메시지 전송 (테이블 리셋 방지)
        if (globalWss) {
          const lowTempStartMessage = `[TEST_PROGRESS] 사이클 ${cycle}: 저온 테스트 시작 (${lowReadCount}회)`;
          
          let sentCount = 0;
          globalWss.clients.forEach(client => {
            if (client.readyState === 1) { // WebSocket.OPEN
              client.send(lowTempStartMessage);
              sentCount++;
            }
          });
          console.log(`[NextTankEnviTestProcess] 사이클 ${cycle} 저온 테스트 시작 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
        }
        
        // 챔버 온도를 읽어서 비교하여 도달하면 테스트 시작
        // 아니면 온도가 도달 할때 까지 대기
        // 온도 대기 중 중지 요청 확인을 위한 간격 - 더 빠른 응답을 위해 1초로 단축
        const lowTempCheckInterval = 1000; // 1초마다 중지 요청 확인
        let lastLowTempCheck = Date.now();
        
        while(true) {
          // 중지 요청 확인 - 온도 대기 중
          if (getProcessStopRequested()) {
            console.log(`[NextTankEnviTestProcess] 🛑 중지 요청 감지 - 저온 테스트 대기 중 중단`);
            
            // 중지 시에도 PowerSwitch 상태를 off로 설정
            setMachineRunningStatus(false);
            console.log(`[NextTankEnviTestProcess] 🔌 중지로 인한 PowerSwitch 상태 OFF 설정`);
            
            // 클라이언트에게 파워스위치 OFF 상태 전송
            if (globalWss) {
              const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - Low temp test waiting stopped`;
              let sentCount = 0;
              globalWss.clients.forEach(client => {
                if (client.readyState === 1) { // WebSocket.OPEN
                  client.send(powerOffMessage);
                  sentCount++;
                }
              });
              console.log(`[NextTankEnviTestProcess] 🔌 저온 테스트 대기 중단으로 인한 파워스위치 OFF 상태 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
            } else {
              console.warn(`[NextTankEnviTestProcess] 전역 WebSocket 서버가 설정되지 않음 - 저온 테스트 대기 중단 시 파워스위치 OFF 메시지 전송 불가`);
            }
            
            // 중단된 테스트 결과 파일 생성
            console.log(`[NextTankEnviTestProcess] 📄 중단된 테스트 결과 파일 생성 시작...`);
            
            try {
              // 테스트 설정 정보 수집
              const testSettings = {
                modelName: getTableOption.productInput?.modelName || 'N/A',
                productNames: getTableOption.productInput?.productNames || ['A-001', 'B-002', 'C-003'],
                temperature: getTableOption.lowTempSettings?.targetTemp || 'N/A',
                highTempEnabled: getTableOption.highTempSettings?.highTemp || false,
                lowTempEnabled: getTableOption.lowTempSettings?.lowTemp || false,
                totalCycles: cycleNumber,
                highTempWaitTime: getTableOption.highTempSettings?.waitTime || 'N/A',
                lowTempWaitTime: getTableOption.lowTempSettings?.waitTime || 'N/A',
                highTempReadCount: getTableOption.highTempSettings?.readCount || 'N/A',
                lowTempReadCount: getTableOption.lowTempSettings?.readCount || 'N/A'
              };
              
              // 중단된 테스트 결과 파일 생성
              const result = await generateInterruptedTestResultFile({
                stopReason: 'manual_stop',
                stoppedAtCycle: cycle,
                stoppedAtPhase: 'low_temp_waiting',
                testSettings
              });
              
              if (result.success) {
                console.log(`[NextTankEnviTestProcess] ✅ 중단된 테스트 결과 파일 생성 완료: ${result.filename}`);
              } else {
                console.error(`[NextTankEnviTestProcess] ❌ 중단된 테스트 결과 파일 생성 실패: ${result.error}`);
              }
            } catch (fileError) {
              console.error(`[NextTankEnviTestProcess] 중단된 테스트 결과 파일 생성 중 오류:`, fileError);
            }
            
            // 수동 중지 시 전역 디렉토리명 초기화 (보고서 생성 후)
            console.log(`[NextTankEnviTestProcess] 📁 수동 중지 - 전역 디렉토리명 초기화: ${currentTestDirectoryName}`);
            // currentTestDirectoryName은 generateInterruptedTestResultFile에서 사용 후 null로 설정됨
            
            return { 
              status: 'stopped', 
              message: '사용자에 의해 중지됨', 
              stoppedAtCycle: cycle, 
              stoppedAtPhase: 'low_temp_waiting',
              totalCycles: cycle
            };
          }
          
          console.log(`[NextTankEnviTestProcess] 사이클 ${cycle}: 저온 테스트 대기 중 목표 온도: ${lowTemp}℃`);

          // 온도 대기 중 중지 요청 확인을 위한 간격 체크
          const now = Date.now();
          if (now - lastLowTempCheck >= lowTempCheckInterval) {
            lastLowTempCheck = now;
            
            // 중지 요청 확인 - 온도 대기 중 주기적 체크
            if (getProcessStopRequested()) {
              console.log(`[NextTankEnviTestProcess] 🛑 중지 요청 감지 - 저온 테스트 온도 대기 중 주기적 체크에서 중단`);
              
              // PowerSwitch 상태 OFF 설정
              setMachineRunningStatus(false);
              
              // 클라이언트에게 파워스위치 OFF 상태 전송
              if (globalWss) {
                const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - Process stopped during low temp waiting`;
                globalWss.clients.forEach(client => {
                  if (client.readyState === 1) {
                    client.send(powerOffMessage);
                  }
                });
              }
              
              // 중단 보고서 생성 (안전한 처리)
              try {
                // 전역 디렉토리명이 있는지 확인
                if (!currentTestDirectoryName) {
                  currentTestDirectoryName = getDateDirectoryName();
                  console.log(`[NextTankEnviTestProcess] ⚠️ 전역 디렉토리명이 없어 새로 생성: ${currentTestDirectoryName}`);
                }
                
                const testSettings = {
                  modelName: getTableOption.productInput?.modelName || 'N/A',
                  productNames: getTableOption.productInput?.productNames || ['A-001', 'B-002', 'C-003'],
                  temperature: getTableOption.lowTempSettings?.targetTemp || 'N/A',
                  totalCycles: cycleNumber
                };
                
                const reportResult = await generateInterruptedTestResultFile({
                  stopReason: 'power_switch_off',
                  stoppedAtCycle: cycle,
                  stoppedAtPhase: 'low_temp_waiting',
                  errorMessage: '사용자에 의한 파워스위치 OFF',
                  testSettings: testSettings
                });
                
                if (reportResult && reportResult.success) {
                  console.log(`[NextTankEnviTestProcess] ✅ 중단 보고서 생성 성공: ${reportResult.filename}`);
                  // 전역 디렉토리명은 유지 (다른 함수에서도 사용)
                  console.log(`[NextTankEnviTestProcess] 📁 전역 디렉토리명 유지: ${currentTestDirectoryName}`);
                } else {
                  console.error(`[NextTankEnviTestProcess] ❌ 중단 보고서 생성 실패:`, reportResult?.error || '알 수 없는 오류');
                }
                
              } catch (error) {
                console.error(`[NextTankEnviTestProcess] ❌ 중단 보고서 생성 실패:`, error.message);
              }
              
              // 프로세스 중지 플래그 상태 유지
              console.log(`[NextTankEnviTestProcess] 🛑 프로세스 중지 상태 유지 - 저온 테스트 온도 대기 중`);
              // setProcessStopRequested(false) 호출 제거
              
              return { 
                status: 'stopped', 
                message: '사용자에 의해 중지됨', 
                stoppedAtCycle: cycle, 
                stoppedAtPhase: 'low_temp_waiting',
                totalCycles: cycle
              };
            }
          }
          
          let chamberTemp = 23.45;
          if( getSimulationMode() != true ){
            chamberTemp = await getCurrentChamberTemperature();
          }
          console.log(`[NextTankEnviTestProcess] 사이클 ${cycle}: 저온 테스트 대기 중 온도: ${chamberTemp}℃`);
          
          // ReadChamber 실패 시 처리
          if (chamberTemp === false) {
            console.error(`[NextTankEnviTestProcess] 🛑 챔버 온도 읽기 실패 - 사이클 ${cycle}에서 프로세스 중단`);
            
            // PowerSwitch 상태를 off로 설정
            setMachineRunningStatus(false);
            console.log(`[NextTankEnviTestProcess] 🔌 챔버 오류로 인한 PowerSwitch 상태 OFF 설정`);
            
            // 클라이언트에게 파워스위치 OFF 상태 전송
            if (globalWss) {
              const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - Chamber read failed`;
              let sentCount = 0;
              globalWss.clients.forEach(client => {
                if (client.readyState === 1) { // WebSocket.OPEN
                  client.send(powerOffMessage);
                  sentCount++;
                }
              });
              console.log(`[NextTankEnviTestProcess] 🔌 챔버 오류로 인한 파워스위치 OFF 상태 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
            } else {
              console.warn(`[NextTankEnviTestProcess] 전역 WebSocket 서버가 설정되지 않음 - 챔버 오류 시 파워스위치 OFF 메시지 전송 불가`);
            }
            
            return { 
              status: 'error', 
              message: '챔버 온도 읽기 실패 - 장비 연결 상태를 확인하세요', 
              stoppedAtCycle: cycle, 
              errorType: 'chamber_read_failed' 
            };
          }
          
          if(chamberTemp <= lowTemp) {
            console.log(`[NextTankEnviTestProcess] 사이클 ${cycle}: 저온 테스트 시작 (${chamberTemp}°C)`);
            console.log(`[NextTankEnviTestProcess] 저온테스트 전 ${lowWaitTime}분 대기`);
            
            // lowWaitTime 분 만큼 대기 (중지 요청 확인 가능)
            try {
              await sleepMinutesWithStopCheck(lowWaitTime, `사이클 ${cycle} 저온 대기`);
            } catch (error) {
              if (error.message === 'PROCESS_STOP_REQUESTED') {
                console.log(`[NextTankEnviTestProcess] 🛑 중지 요청 감지 - 저온 대기 중 중단`);
                
                // 중지 시에도 PowerSwitch 상태를 off로 설정
                setMachineRunningStatus(false);
                console.log(`[NextTankEnviTestProcess] 🔌 중지로 인한 PowerSwitch 상태 OFF 설정`);
                
                // 클라이언트에게 파워스위치 OFF 상태 전송
                if (globalWss) {
                  const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - Low temp waiting stopped`;
                  let sentCount = 0;
                  globalWss.clients.forEach(client => {
                    if (client.readyState === 1) { // WebSocket.OPEN
                      client.send(powerOffMessage);
                      sentCount++;
                    }
                  });
                  console.log(`[NextTankEnviTestProcess] 🔌 저온 대기 중단으로 인한 파워스위치 OFF 상태 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
                } else {
                  console.warn(`[NextTankEnviTestProcess] 전역 WebSocket 서버가 설정되지 않음 - 저온 대기 중단 시 파워스위치 OFF 메시지 전송 불가`);
                }
                
                return { 
                  status: 'stopped', 
                  message: '사용자에 의해 중지됨', 
                  stoppedAtCycle: cycle, 
                  stoppedAtPhase: 'low_temp_waiting',
                  totalCycles: cycle
                };
              } else {
                throw error; // 다른 에러는 다시 던짐
              }
            }
            
            // runSinglePageProcess 를 readCount 만큼 실행
            for(let i = 0; i < lowReadCount; i++) {
              // 중지 요청 확인
              if (getProcessStopRequested()) {
                console.log(`[NextTankEnviTestProcess] 🛑 중지 요청 감지 - 저온 테스트 실행 중 중단 (${i+1}/${lowReadCount})`);
                
                // PowerSwitch 상태 OFF 설정
                setMachineRunningStatus(false);
                
                // 클라이언트에게 파워스위치 OFF 상태 전송
                if (globalWss) {
                  const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - Low temp test execution stopped`;
                  globalWss.clients.forEach(client => {
                    if (client.readyState === 1) {
                      client.send(powerOffMessage);
                    }
                  });
                }
                
                // 중단 보고서는 최종 종료 시에만 생성하도록 수정
                console.log(`[NextTankEnviTestProcess] 📄 중단 보고서는 최종 종료 시에 생성됩니다.`);
                
                return { 
                  status: 'stopped', 
                  message: '사용자에 의해 중단됨', 
                  stoppedAtCycle: cycle, 
                  stoppedAtPhase: 'low_temp_test', 
                  stoppedAtTest: i+1,
                  totalCycles: cycle
                };
              }
              
              console.log(`[NextTankEnviTestProcess] 사이클 ${cycle}: 저온 테스트 ${i+1}/${lowReadCount} 실행`);
              
              // 현재 테스트 번호를 간단한 진행 상황 메시지로 업데이트 (테이블 리셋 방지)
              if (globalWss) {
                const testProgressMessage = `[TEST_PROGRESS] 사이클 ${cycle}: 저온 테스트 ${i+1}/${lowReadCount} 실행 중`;
                
                let sentCount = 0;
                globalWss.clients.forEach(client => {
                  if (client.readyState === 1) { // WebSocket.OPEN
                    client.send(testProgressMessage);
                    sentCount++;
                  }
                });
                console.log(`[NextTankEnviTestProcess] 사이클 ${cycle} 저온 테스트 ${i+1}/${lowReadCount} 진행 상황 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
              }
              
              // SinglePageProcess 재시도 로직 (최대 5회)
              let singlePageSuccess = false;
              let retryCount = 0;
              const maxRetries = 5;
              let singlePageResult = null;
              
              while (!singlePageSuccess && retryCount < maxRetries) {
                try {
                  singlePageResult = await runSinglePageProcess();
                  
                  if (singlePageResult.status === 'stopped') {
                    console.log(`[NextTankEnviTestProcess] 🛑 SinglePageProcess 중지됨: ${singlePageResult.message}`);
                    console.log(`[NextTankEnviTestProcess] 🛑 SinglePageProcess 중지로 인한 중단 보고서 생성`);
                    
                    // PowerSwitch 상태를 off로 설정
                    setMachineRunningStatus(false);
                    
                    // 클라이언트에게 파워스위치 OFF 상태 전송
                    if (globalWss) {
                      const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - SinglePageProcess stopped`;
                      let sentCount = 0;
                      globalWss.clients.forEach(client => {
                        if (client.readyState === 1) { // WebSocket.OPEN
                          client.send(powerOffMessage);
                          sentCount++;
                        }
                      });
                      console.log(`[NextTankEnviTestProcess] 🔌 SinglePageProcess 중지로 인한 파워스위치 OFF 상태 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
                    }
                    
                    // 중단 보고서는 최종 종료 시에만 생성하도록 수정
                    console.log(`[NextTankEnviTestProcess] 📄 중단 보고서는 최종 종료 시에 생성됩니다.`);
                    
                    // 전역 디렉토리명 초기화
                    currentTestDirectoryName = null;
                    
                    // 중단 상태로 프로세스 완료
                    return { 
                      status: 'stopped', 
                      message: 'SinglePageProcess 중지로 인한 전체 프로세스 중단',
                      stoppedAtCycle: cycle,
                      stoppedAtPhase: 'low_temp_test',
                      stopReason: 'SinglePageProcess_stopped',
                      finalReportGenerated: true
                    };
                  }
                  
                  if (singlePageResult && singlePageResult.status === 'completed' && singlePageResult.data) {
                    singlePageSuccess = true;
                    console.log(`[NextTankEnviTestProcess] 사이클 ${cycle} 저온 테스트 ${i+1}/${lowReadCount} 성공 (${retryCount + 1}번째 시도)`);
                  } else {
                    throw new Error(`SinglePageProcess 실패: ${singlePageResult?.message || '알 수 없는 오류'}`);
                  }
                } catch (error) {
                  retryCount++;
                  console.warn(`[NextTankEnviTestProcess] 사이클 ${cycle} 저온 테스트 ${i+1}/${lowReadCount} 실패 (${retryCount}/${maxRetries}): ${error.message}`);
                  
                  if (retryCount < maxRetries) {
                    console.log(`[NextTankEnviTestProcess] 3초 후 재시도...`);
                    await sleep(3000);
                  } else {
                    console.error(`[NextTankEnviTestProcess] 사이클 ${cycle} 저온 테스트 ${i+1}/${lowReadCount} 최종 실패 - 프로세스 중단`);
                    
                    // PowerSwitch 상태를 off로 설정
                    setMachineRunningStatus(false);
                    console.log(`[NextTankEnviTestProcess] 🔌 저온 테스트 실패로 인한 PowerSwitch 상태 OFF 설정`);
                    
                    // 최종 실패 시에도 중단 보고서 생성
                    try {
                      const testSettings = {
                        modelName: getTableOption.productInput?.modelName || 'N/A',
                        productNames: getTableOption.productInput?.productNames || ['A-001', 'B-002', 'C-003'],
                        temperature: getTableOption.lowTempSettings?.targetTemp || 'N/A',
                        totalCycles: cycleNumber
                      };
                      
                      const reportResult = await generateInterruptedTestResultFile({
                        stopReason: 'low_temp_test_failed',
                        stoppedAtCycle: cycle,
                        stoppedAtPhase: 'low_temp_test',
                        errorMessage: `저온 테스트 ${i+1}/${lowReadCount} 실패 - 5회 재시도 후 최종 실패`,
                        testSettings: testSettings
                      });
                      
                      if (reportResult && reportResult.success) {
                        console.log(`[NextTankEnviTestProcess] ✅ 최종 실패로 인한 중단 보고서 생성 성공: ${reportResult.filename}`);
                      } else {
                        console.error(`[NextTankEnviTestProcess] ❌ 최종 실패로 인한 중단 보고서 생성 실패:`, reportResult?.error || '알 수 없는 오류');
                      }
                    } catch (reportError) {
                      console.error(`[NextTankEnviTestProcess] ❌ 최종 실패로 인한 중단 보고서 생성 실패:`, reportError.message);
                    }
                    
                    // 전역 디렉토리명 초기화
                    currentTestDirectoryName = null;
                    
                    return { 
                      status: 'error', 
                      message: `저온 테스트 ${i+1}/${lowReadCount} 실패 - 5회 재시도 후 최종 실패`, 
                      stoppedAtCycle: cycle, 
                      stoppedAtPhase: 'low_temp_test', 
                      stoppedAtTest: i+1,
                      errorType: 'low_temp_test_failed',
                      finalReportGenerated: true
                    };
                  }
                }
              }
              
              // 각 실행 결과를 개별 파일로 저장
              if (singlePageResult && singlePageResult.status === 'completed' && singlePageResult.data) {
                console.log(`[NextTankEnviTestProcess] 사이클 ${cycle} 저온 테스트 ${i+1}/${lowReadCount} 결과 저장 시작`);
                const saveResult = await saveTotaReportTableToFile(
                  singlePageResult.data, 
                  getTableOption.channelVoltages, 
                  cycle, 
                  `LowTemp_Test${i+1}`
                );
                if (saveResult.success) {
                  console.log(`[NextTankEnviTestProcess] 사이클 ${cycle} 저온 테스트 ${i+1}/${lowReadCount} 결과 저장 완료: ${saveResult.filename}`);
                } else {
                  console.error(`[NextTankEnviTestProcess] 사이클 ${cycle} 저온 테스트 ${i+1}/${lowReadCount} 결과 저장 실패: ${saveResult.error}`);
                }
                
                // 결과 누적 (기존 로직 유지)
                lowTempResults.push(singlePageResult.data);
              }
            }
            console.log(`[NextTankEnviTestProcess] 사이클 ${cycle}: 저온 테스트 완료 (${lowTempResults.length}개 결과 누적)`);
            
            // 실행완료 하면 빠져 나감
            break;
          } else {
            console.log(`[NextTankEnviTestProcess] 사이클 ${cycle}: 저온 대기 중... 현재: ${chamberTemp}°C, 목표: ${lowTemp}°C`);
            await sleep(60000); // 1분 대기
          }
        }
      }
      
      console.log(`[NextTankEnviTestProcess] === 사이클 ${cycle}/${cycleNumber} 완료 ===`);
      
      // 마지막 사이클이 아니면 다음 사이클을 위한 대기 시간 추가
      if (cycle < cycleNumber) {
        console.log(`[NextTankEnviTestProcess] 다음 사이클을 위한 대기 중...`);
        await sleep(5000); // 5초 대기 (필요에 따라 조정 가능)
      }
    }
    
    console.log(`[NextTankEnviTestProcess] 모든 사이클(${cycleNumber}회) 완료`);
    
    // 모든 사이클 완료 후 종합 리포트 생성 (FinalReportGenerator 로직 사용)
    console.log(`[NextTankEnviTestProcess] 📄 모든 사이클 완료 - 종합 리포트 생성`);
    try {
      const finalReportResult = await generateFinalReportFromDirectory(
        currentTestDirectoryPath || path.join(process.cwd(), 'Data', 'default'), 
        currentTestDirectoryName || 'default'
      );
      if (finalReportResult && finalReportResult.success) {
        console.log(`[NextTankEnviTestProcess] ✅ 종합 리포트 생성 성공: ${finalReportResult.filename}`);
      } else {
        console.error(`[NextTankEnviTestProcess] ❌ 종합 리포트 생성 실패:`, finalReportResult?.error || '알 수 없는 오류');
      }
    } catch (error) {
      console.error(`[NextTankEnviTestProcess] ❌ 종합 리포트 생성 실패:`, error.message);
    }
    
    // PowerSwitch 상태 OFF 설정
    setMachineRunningStatus(false);
    
    // 클라이언트에게 파워스위치 OFF 상태 전송
    if (globalWss) {
      const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - Test completed`;
      globalWss.clients.forEach(client => {
        if (client.readyState === 1) {
          client.send(powerOffMessage);
        }
      });
    }
    
    // 프로세스 중지 플래그 초기화 제거 - 중지 상태 유지
    console.log(`[NextTankEnviTestProcess] 🛑 프로세스 완료 - 중지 플래그 상태 유지`);
    // setProcessStopRequested(false) 호출 제거
    
    // 프로세스 완료 후 전역 디렉토리명 초기화 (모든 파일 생성 완료 후)
    console.log(`[NextTankEnviTestProcess] 📁 프로세스 완료 - 전역 디렉토리명 초기화: ${currentTestDirectoryName}`);
    currentTestDirectoryName = null;
    
    return { 
      status: 'completed', 
      message: '모든 사이클 완료 및 종합 리포트 생성 완료',
      totalCycles: cycleNumber,
      finalReportGenerated: true
    };
    
  } catch (error) {
    console.error('[NextTankEnviTestProcess] 예외 발생:', error);
    
    // SinglePageProcess 중지로 인한 에러인지 확인
    if (error.status === 'stopped_by_singlepage') {
      console.log(`[NextTankEnviTestProcess] 🛑 SinglePageProcess 중지로 인한 프로세스 중단 처리`);
      
      // PowerSwitch 상태 OFF 설정
      setMachineRunningStatus(false);
      
      // 프로세스 중지 플래그 초기화 제거 - 중지 상태 유지
      console.log(`[NextTankEnviTestProcess] 🛑 SinglePageProcess 중지 - 중지 플래그 상태 유지`);
      // setProcessStopRequested(false) 호출 제거
      
      // 클라이언트에게 파워스위치 OFF 상태 전송
      if (globalWss) {
        const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - SinglePageProcess stopped`;
        let sentCount = 0;
        globalWss.clients.forEach(client => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(powerOffMessage);
            sentCount++;
          }
        });
        console.log(`[NextTankEnviTestProcess] 🔌 SinglePageProcess 중지로 인한 파워스위치 OFF 상태 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
      }
      
      // 전역 디렉토리명 초기화
      currentTestDirectoryName = null;
      
      // SinglePageProcess 중지로 인한 프로세스 완료 반환
      return {
        status: 'completed',
        message: error.message,
        stoppedAtCycle: error.stoppedAtCycle,
        stoppedAtPhase: error.stoppedAtPhase,
        stoppedAtTest: error.stoppedAtTest,
        finalReportGenerated: error.finalReportGenerated,
        result: error.result,
        totalCycles: error.stoppedAtCycle || 1
      };
    }
    
    // 일반 에러 발생 시 PowerSwitch 상태 OFF 설정
    setMachineRunningStatus(false);
    
    // 에러 발생 시 프로세스 중지 플래그 초기화 제거 - 중지 상태 유지
    console.log(`[NextTankEnviTestProcess] 🛑 에러 발생 - 중지 플래그 상태 유지`);
    // setProcessStopRequested(false) 호출 제거
    
    // 에러 발생 시에도 클라이언트에게 파워스위치 OFF 상태 전송
    if (globalWss) {
      const powerOffMessage = `[POWER_SWITCH] OFF - Machine running: false - Error occurred`;
      let sentCount = 0;
      globalWss.clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(powerOffMessage);
          sentCount++;
        }
      });
      console.log(`[NextTankEnviTestProcess] 🔌 에러 발생으로 인한 파워스위치 OFF 상태 메시지 전송 완료 - 클라이언트 수: ${sentCount}`);
    } else {
      console.warn(`[NextTankEnviTestProcess] 전역 WebSocket 서버가 설정되지 않음 - 에러 발생 시 파워스위치 OFF 메시지 전송 불가`);
    }
    
    // 에러 발생 시에도 중단된 테스트 결과 파일 생성
    console.log(`[NextTankEnviTestProcess] 📄 에러로 인한 중단된 테스트 결과 파일 생성 시작...`);
    
    try {
      // 테스트 설정 정보 수집 (에러 발생 시에는 기본값 사용)
      const testSettings = {
        modelName: 'N/A',
        productNames: ['A-001', 'B-002', 'C-003'],
        temperature: 'N/A',
        highTempEnabled: false,
        lowTempEnabled: false,
        totalCycles: 1,
        highTempWaitTime: 'N/A',
        lowTempWaitTime: 'N/A',
        highTempReadCount: 'N/A',
        lowTempReadCount: 'N/A'
      };
      
      // 중단된 테스트 결과 파일 생성 (안전한 처리)
      try {
        // 전역 디렉토리명이 있는지 확인
        if (!currentTestDirectoryName) {
          currentTestDirectoryName = getDateDirectoryName();
          console.log(`[NextTankEnviTestProcess] ⚠️ 전역 디렉토리명이 없어 새로 생성: ${currentTestDirectoryName}`);
        }
        
        const result = await generateInterruptedTestResultFile({
          stopReason: 'error',
          stoppedAtCycle: 1, // 에러 발생 시에는 사이클 1로 가정
          stoppedAtPhase: 'unknown',
          errorMessage: error.message || '알 수 없는 에러',
          testSettings
        });
        
        if (result && result.success) {
          console.log(`[NextTankEnviTestProcess] ✅ 에러로 인한 중단된 테스트 결과 파일 생성 완료: ${result.filename}`);
          // 전역 디렉토리명은 유지 (다른 함수에서도 사용)
          console.log(`[NextTankEnviTestProcess] 📁 전역 디렉토리명 유지: ${currentTestDirectoryName}`);
        } else {
          console.error(`[NextTankEnviTestProcess] ❌ 에러로 인한 중단된 테스트 결과 파일 생성 실패:`, result?.error || '알 수 없는 오류');
        }
      } catch (reportError) {
        console.error(`[NextTankEnviTestProcess] ❌ 에러로 인한 중단 보고서 생성 실패:`, reportError.message);
      }
          } catch (fileError) {
        console.error(`[NextTankEnviTestProcess] 에러로 인한 중단된 테스트 결과 파일 생성 중 오류:`, fileError);
      }
      
      // SinglePageProcess 중지가 아닌 일반 에러인 경우에도 중단 보고서 생성 후 프로세스 완료
      if (error.status !== 'stopped_by_singlepage') {
        console.log(`[NextTankEnviTestProcess] 🛑 일반 에러로 인한 프로세스 중단 - 중단 보고서 생성 완료`);
        
        // 전역 디렉토리명은 유지 (다른 함수에서도 사용)
        console.log(`[NextTankEnviTestProcess] 📁 전역 디렉토리명 유지: ${currentTestDirectoryName}`);
        
        // 에러 상태로 프로세스 완료 (에러를 다시 던지지 않음)
        return {
          status: 'error',
          message: error.message || '알 수 없는 에러',
          errorType: 'general_error',
          finalReportGenerated: true,
          totalCycles: 1
        };
      }
  }
}

// resetTableData 함수는 RunTestProcess.js에서 import하여 사용
