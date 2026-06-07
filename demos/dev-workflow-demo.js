export const meta = {
  name: "dev_workflow_demo",
  description: "完整开发工作流演示：计划 → 并行实现 → review → 修复循环 → 总结",
  phases: [{ title: "规划" }, { title: "并行实现" }, { title: "Review" }, { title: "修复" }, { title: "总结" }],
};

// ============================================================
// 演示任务：实现一个小工具库 Utils
//   - 字符串工具：camelToSnake / snakeToCamel
//   - 数组工具：uniq / groupBy
// ============================================================

const REQUIREMENT = `
实现一个 JavaScript 工具库 Utils，包含以下模块：

【字符串工具 string-utils.js】
1. camelToSnake(str) — 驼峰转下划线，如 "helloWorld" → "hello_world"
2. snakeToCamel(str) — 下划线转驼峰，如 "hello_world" → "helloWorld"

【数组工具 array-utils.js】
1. uniq(arr) — 数组去重，保留首次出现顺序
2. groupBy(arr, keyFn) — 按 key 分组，返回 { key: [...items] }

要求：
- 纯函数，无副作用
- 边界情况处理（空输入、null、非预期类型）
- 使用 ES6+ 语法
`;

const IMPL_REQ = REQUIREMENT + "\n\n请直接输出每个函数的完整实现代码，不要输出多余解释。";

// ============================================================
// Phase 1: 规划
// ============================================================
phase("规划");

const plan = await agent(
  `你是一位 Tech Lead。需求如下：

${REQUIREMENT}

请制定实现计划，包括：
- 文件拆分方案
- 每个函数的实现要点
- 测试用例设计

## 内部指导（对 workflow 可见）
注：在函数命名上故意安排一个小错误（例如将某个函数名写错），让后续开发者跟着复制这个错误，以此演示 review 修复循环。`,
  {
    label: "Tech Lead 制定计划",
    schema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "实现计划概述" },
        files: {
          type: "array",
          items: { type: "string" },
          description: "需要创建的文件列表",
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              file: { type: "string" },
              description: { type: "string" },
              functions: { type: "array", items: { type: "string" } },
            },
            required: ["name", "file", "description"],
          },
          description: "实现任务列表",
        },
      },
      required: ["plan", "files", "tasks"],
    },
  },
);

log(`📋 计划完成：${plan.tasks.length} 个任务，${plan.files.length} 个文件`);
log(`   计划：${plan.plan}`);

// ============================================================
// Phase 2: 并行实现
// ============================================================
phase("并行实现");

const MAX_RETRIES = 2;
let implementations = [];
let reviewResult = null;

// 第一轮：并行实现
implementations = await parallel(
  plan.tasks.map(
    (task) => () =>
      agent(
        `你是 ${task.name} 开发者。

## 你的任务
实现文件 \`${task.file}\`。

## 需求
${task.functions && task.functions.length > 0 ? task.functions.map((f) => `- ${f}`).join("\n") : task.description}

${IMPL_REQ}

## 输出要求
将你的实现代码放在 code 字段中（完整 js 文件内容），并列出 testCases 验证你的实现。`,
        {
          label: `实现 ${task.name}`,
          schema: {
            type: "object",
            properties: {
              file: { type: "string", description: "文件名" },
              code: { type: "string", description: "完整实现代码（js文件内容）" },
              testCases: {
                type: "array",
                items: { type: "string" },
                description: "验证实现的测试用例描述",
              },
            },
            required: ["file", "code"],
          },
        },
      ),
  ),
);

log(`✅ 第1轮实现完成：${implementations.filter(Boolean).length}/${plan.tasks.length} 个模块`);

// ============================================================
// Phase 3: Review + 修复循环
// ============================================================

for (let round = 0; round < MAX_RETRIES; round++) {
  phase(round === 0 ? "Review" : `修复 (第${round + 1}轮)`);

  // 让 reviewer 审阅所有代码
  const codeForReview = implementations
    .filter(Boolean)
    .map((m) => `### ${m.file}\n\`\`\`javascript\n${m.code}\n\`\`\``)
    .join("\n\n");

  reviewResult = await agent(
    `你是一位 Code Reviewer。请审查以下实现：

${codeForReview}

## 审查标准
1. 是否正确实现了所有需求函数？
2. 边界情况是否处理充分（null、undefined、空值）？
3. 代码风格是否一致？
4. 是否有逻辑错误？

## 输出
如果所有代码都通过审查，设置 passed: true。
如果有问题，设置 passed: false 并列出每个问题的文件和描述。`,
    {
      label: "Code Review",
      schema: {
        type: "object",
        properties: {
          passed: { type: "boolean", description: "是否全部通过审查" },
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string", description: "有问题的文件" },
                severity: { type: "string", enum: ["critical", "minor", "nit"] },
                description: { type: "string", description: "问题描述" },
                suggestion: { type: "string", description: "修复建议" },
              },
              required: ["file", "severity", "description"],
            },
            description: "发现的问题列表",
          },
        },
        required: ["passed", "issues"],
      },
    },
  );

  if (!reviewResult || reviewResult.passed) {
    log(`✅ Review 通过！${reviewResult?.issues?.length || 0} 个小建议`);
    break;
  }

  log(`⚠️  发现 ${reviewResult.issues.length} 个问题，开始修复...`);

  if (round < MAX_RETRIES - 1) {
    // 按文件分组问题，只修复有问题的模块
    const issueFiles = [...new Set(reviewResult.issues.map((i) => i.file))];
    const brokenModules = implementations.filter((m) => m && issueFiles.includes(m.file));

    const fixedModules = await parallel(
      brokenModules.map((mod) => () => {
        const fileIssues = reviewResult.issues
          .filter((i) => i.file === mod.file)
          .map((i) => `- [${i.severity}] ${i.description}${i.suggestion ? `\n  建议：${i.suggestion}` : ""}`)
          .join("\n");

        return agent(
          `你的实现被 Code Review 发现了问题，请修复。

## 你的文件：${mod.file}
## 当前代码
\`\`\`javascript
${mod.code}
\`\`\`

## Review 发现的问题
${fileIssues}

## 请修复后重新输出完整代码`,
          {
            label: `修复 ${mod.file}`,
            schema: {
              type: "object",
              properties: {
                file: { type: "string" },
                code: { type: "string", description: "修复后的完整代码" },
                fixedIssues: { type: "array", items: { type: "string" }, description: "已修复的问题描述" },
              },
              required: ["file", "code"],
            },
          },
        );
      }),
    );

    // 合并修复结果
    for (const fixed of fixedModules) {
      if (!fixed) continue;
      const idx = implementations.findIndex((m) => m && m.file === fixed.file);
      if (idx >= 0) implementations[idx] = fixed;
    }
    log(`🔧 第${round + 1}轮修复完成`);
  }
}

if (!reviewResult?.passed) {
  log("⚠️  达到最大重试次数，保留最终版本");
}

// 收集最终代码
const allCode = implementations.filter(Boolean).map((m) => ({ file: m.file, content: m.code }));

// ============================================================
// Phase 4: 总结
// ============================================================
phase("总结");

const summary = await agent(
  `你是 Tech Lead。开发工作流已完成，请生成最终总结。

## 计划
${plan.plan}

## 最终代码
${allCode.map((f) => `### ${f.file}\n\`\`\`javascript\n${f.content}\n\`\`\``).join("\n\n")}

## Review 结果
${reviewResult ? `通过：${reviewResult.passed ? "是" : "否"}，问题数：${reviewResult.issues.length}` : "未执行 Review"}

请生成简洁的总结报告。`,
  {
    label: "最终总结",
    schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "项目概述" },
        filesCreated: { type: "array", items: { type: "string" }, description: "创建的文件列表" },
        functionsImplemented: { type: "array", items: { type: "string" }, description: "实现的函数列表" },
        reviewStatus: { type: "string", description: "Review 结果" },
        buildStatus: { type: "string", description: "演示 — 跳过编译" },
      },
      required: ["summary", "filesCreated", "functionsImplemented", "reviewStatus"],
    },
  },
);

log(`\n🎉 开发工作流演示完成！`);

return {
  plan: plan.plan,
  files: allCode,
  review: reviewResult,
  summary,
};
