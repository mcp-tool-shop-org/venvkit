# Venvkit Test Coverage Requirements

**Goal:** Reach 100% coverage across environment scanning, task clustering, rendering, and CLI tools.

**Current State:**
- Source modules: TypeScript files in root
- Some tests exist but comprehensive coverage needed

---

## 1) doctorLite.ts
**Priority: CRITICAL**
- `test_doctor_detects_missing_dependencies`
- `test_doctor_checks_python_version`
- `test_doctor_validates_node_version`
- `test_doctor_finds_venv_issues`
- `test_doctor_reports_path_problems`
- `test_doctor_handles_no_issues`
- `test_doctor_suggests_fixes`

## 2) scanEnvPaths.ts
**Priority: HIGH**
- `test_scan_finds_python_venvs`
- `test_scan_finds_node_modules`
- `test_scan_respects_ignore_patterns`
- `test_scan_handles_symlinks`
- `test_scan_detects_nested_envs`
- `test_scan_handles_permission_errors`
- `test_scan_empty_directory`
- `test_scan_large_directory_tree`

## 3) taskCluster.ts
**Priority: HIGH**
- `test_cluster_groups_related_tasks`
- `test_cluster_respects_dependencies`
- `test_cluster_handles_cycles`
- `test_cluster_empty_task_list`
- `test_cluster_single_task`
- `test_cluster_independent_tasks`
- `test_cluster_complex_dag`

## 4) runLog.ts
**Priority: MEDIUM**
- `test_log_records_task_start`
- `test_log_records_task_completion`
- `test_log_records_task_failure`
- `test_log_handles_concurrent_tasks`
- `test_log_persistence`
- `test_log_retrieval`
- `test_log_clear`

## 5) mapRender.ts
**Priority: HIGH**
- `test_render_dependency_graph`
- `test_render_empty_graph`
- `test_render_single_node`
- `test_render_complex_graph`
- `test_render_with_clusters`
- `test_render_handles_invalid_data`
- `test_render_output_formats`

## 6) map_cli.ts
**Priority: CRITICAL**
- `test_cli_parse_arguments`
- `test_cli_help_output`
- `test_cli_invalid_arguments`
- `test_cli_doctor_command`
- `test_cli_scan_command`
- `test_cli_map_command`
- `test_cli_exit_codes`

## 7) Integration Tests
**Priority: CRITICAL**
- `test_end_to_end_scan_and_doctor`
- `test_end_to_end_task_clustering`
- `test_end_to_end_graph_rendering`
- `test_full_workflow_with_logging`
- `test_cli_integration`

---

## Suggested Test Layout
```
core/venvkit/
  doctorLite.test.ts (exists)
  scanEnvPaths.test.ts
  taskCluster.test.ts (exists)
  runLog.test.ts (exists)
  mapRender.test.ts (exists)
  map_cli.test.ts
  integration.test.ts
```

---

## Notes
- Use temp directories for scan tests
- Mock file system operations where appropriate
- Test with various Python/Node versions
- Include error case coverage
- Test concurrent operations for task clustering
- Validate graph output formats (DOT, JSON, etc.)
