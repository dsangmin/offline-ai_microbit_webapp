// micro:bit V1.5 · MakeCode JavaScript 편집기에 전체를 붙여넣으세요.
// 웹앱에서 선택한 클래스 이름과 공백까지 정확히 일치시켜 주세요.
const START_CLASS = "펼친 손"
const PAUSE_CLASS = "주먹"

serial.redirectToUSB()
serial.setBaudRate(BaudRate.BaudRate115200)

function showRunning() {
    basic.showLeds(`
        . # . . .
        . # # . .
        . # # # .
        . # # . .
        . # . . .
    `, 0)
}

function showPaused() {
    basic.showLeds(`
        . # . # .
        . # . # .
        . # . # .
        . # . # .
        . # . # .
    `, 0)
}

let finished = false
let blinkOn = false
basic.showIcon(IconNames.SmallDiamond, 0)

serial.onDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    const message = serial.readUntil(serial.delimiters(Delimiters.NewLine))
    // AI의 클래스 이름은 변환하지 않은 UTF-8 문자열로 수신합니다.
    if (message == START_CLASS || message == "@timer:running") {
        finished = false
        showRunning()
    } else if (message == PAUSE_CLASS || message == "@timer:paused") {
        finished = false
        showPaused()
    } else if (message == "@timer:ready") {
        finished = false
        basic.showIcon(IconNames.SmallDiamond, 0)
    } else if (message == "@timer:finished") {
        finished = true
        blinkOn = true
        basic.showIcon(IconNames.Yes, 0)
    }
    // 기타 클래스는 현재 표시를 유지합니다.
})

basic.forever(function () {
    if (finished) {
        blinkOn = !blinkOn
        if (blinkOn) {
            basic.showIcon(IconNames.Yes, 0)
        } else {
            basic.clearScreen()
        }
    }
    basic.pause(500)
})
