/**
 * 待办事项的共享出口：面板构建、展示格式化与 wire 类型。
 *
 * 判据（排序、紧迫度、时间格式化）都是纯函数；面板只依赖 DOM 与 fetch，两端同一份。
 * 浏览器半侧从气泡外壳直接 import 本模块，桌面 shared-core 经 shared/index 打包同一份。
 * @module dsh-pet/src/shared/todo
 */
export { addTodo, loadTodos, patchTodo, removeTodo, TODOS_PATH } from './api';
export { createTodoPanel } from './panel';
export type { TodoPanel, TodoPanelOptions } from './panel';
export { todoPanelTopMarginPx } from './styles';
export { TODO_HOTKEY_HINT, isTodoHotkey } from './hotkey';
export {
  dueLabel,
  formatDateTimeLocal,
  metaLabel,
  parseDateTimeLocal,
  remainingLabel,
  spanText,
  todoUrgency,
} from './format';
export type { TodoUrgency } from './format';
export { parseTodoItem, parseTodoList, sortTodoItems } from './types';
export type { TodoItem } from './types';
