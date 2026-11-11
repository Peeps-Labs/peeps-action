"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/list-projects.ts
var list_projects_exports = {};
__export(list_projects_exports, {
  default: () => ListProjects
});
module.exports = __toCommonJS(list_projects_exports);
var import_node_fs = require("node:fs");
var ListProjects = class {
  onBegin(config) {
    const file = process.env.PEEPS_PROJECTS_FILE;
    if (!file) return;
    const projects = config.projects.map((project) => ({ name: project.name, dependencies: project.dependencies, teardown: project.teardown }));
    (0, import_node_fs.writeFileSync)(file, JSON.stringify(projects), { mode: 384 });
  }
  printsToStdio() {
    return false;
  }
};
