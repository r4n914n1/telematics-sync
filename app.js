const STORAGE_KEY = "orbit-board.tasks.v1";

const taskForm = document.getElementById("task-form");
const taskInput = document.getElementById("task-input");
const taskList = document.getElementById("task-list");
const statusText = document.getElementById("status-text");
const filterButtons = [...document.querySelectorAll("[data-filter]")];
const clearDoneBtn = document.getElementById("clear-done");
const taskTemplate = document.getElementById("task-item-template");

let tasks = loadTasks();
let activeFilter = "all";

render();

taskForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const value = taskInput.value.trim();
  if (!value) {
    return;
  }

  tasks.unshift({
    id: crypto.randomUUID(),
    text: value,
    done: false,
    createdAt: Date.now()
  });

  taskInput.value = "";
  saveTasks(tasks);
  render();
  taskInput.focus();
});

taskList.addEventListener("click", (event) => {
  const item = event.target.closest(".task-item");
  if (!item) {
    return;
  }

  const id = item.dataset.id;

  if (event.target.classList.contains("delete-btn")) {
    tasks = tasks.filter((task) => task.id !== id);
    saveTasks(tasks);
    render();
  }
});

taskList.addEventListener("change", (event) => {
  if (!event.target.classList.contains("task-toggle")) {
    return;
  }

  const item = event.target.closest(".task-item");
  if (!item) {
    return;
  }

  const task = tasks.find((entry) => entry.id === item.dataset.id);
  if (!task) {
    return;
  }

  task.done = event.target.checked;
  saveTasks(tasks);
  render();
});

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    filterButtons.forEach((entry) => entry.classList.remove("active"));
    button.classList.add("active");
    render();
  });
});

clearDoneBtn.addEventListener("click", () => {
  tasks = tasks.filter((task) => !task.done);
  saveTasks(tasks);
  render();
});

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTasks(nextTasks) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextTasks));
}

function getVisibleTasks() {
  if (activeFilter === "active") {
    return tasks.filter((task) => !task.done);
  }

  if (activeFilter === "done") {
    return tasks.filter((task) => task.done);
  }

  return tasks;
}

function render() {
  const visible = getVisibleTasks();
  taskList.textContent = "";

  visible.forEach((task) => {
    const fragment = taskTemplate.content.cloneNode(true);
    const item = fragment.querySelector(".task-item");
    const text = fragment.querySelector(".task-text");
    const toggle = fragment.querySelector(".task-toggle");

    item.dataset.id = task.id;
    item.classList.toggle("done", task.done);
    text.textContent = task.text;
    toggle.checked = task.done;

    taskList.appendChild(fragment);
  });

  const total = tasks.length;
  const done = tasks.filter((task) => task.done).length;
  const active = total - done;
  statusText.textContent = `${total} tasks • ${active} active • ${done} done`;
}