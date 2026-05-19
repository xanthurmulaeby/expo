import { NativeModule, isRunningInExpoGo, requireNativeModule, } from 'expo';
import ExpoGoCalendarNextStub from './ExpoGoCalendarNextStub';
export default isRunningInExpoGo()
    ? ExpoGoCalendarNextStub
    : requireNativeModule('CalendarNext');
//# sourceMappingURL=ExpoCalendar.js.map