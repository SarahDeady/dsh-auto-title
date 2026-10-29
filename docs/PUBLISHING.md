# 怎么把它开源（一步一步来）

> 写给第一次开源的人。全程只需要：一个 GitHub 账号、已经装好的 Git（你机器上已经有 `git 2.56`）、以及这个文件夹。
> 所有命令都在 **PowerShell 或 Git Bash** 里执行；`cd` 到仓库目录开始。

---

## 第 0 步：先确认要提交什么

```powershell
cd C:\Users\SarahDeady\Documents\deepseek-harness\default-workspace\dsh-auto-title
```

这个目录里现在有：

```
dsh-auto-title/
├─ index.js            Host 半（注册标题 provider + 刷新路由）
├─ client.js           客户端半（会话菜单里的「刷新标题」）
├─ cordis.patch.yml    挂载补丁（顺带停用内置 session-title-llm）
├─ package.json        包清单（名字、exports、icon、client 声明）
├─ locale/zh.json      中文文案（菜单项 + 插件名/描述）
├─ locale/en.json      英文文案
├─ icon.svg            图标
├─ test/smoke.mjs      15 个用例，npm test 跑
├─ README.md           说明文档（中英）
├─ CHANGELOG.md        更新日志
├─ LICENSE             MIT
└─ .gitignore          忽略 node_modules 等
```

先跑一次测试，确认没问题再提交：

```powershell
npm test
```

看到 `15/15 通过 · 0 失败` 就可以继续。

---

## 第 1 步：在本地建立仓库并提交

```powershell
git init
git add .
git status
```

`git status` 里**必须看不到** `node_modules`、日志、`.env` 之类（`.gitignore` 已经挡住了）。确认无误：

```powershell
git commit -m "feat: 自动会话标题插件 1.0.0"
```

如果 Git 抱怨不知道你是谁（换电脑时会出现）：

```powershell
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
```

---

## 第 2 步：在 GitHub 上建一个空仓库

1. 打开 <https://github.com/new>；
2. **Repository name** 填 `dsh-auto-title`；
3. 选 **Public**（想先私有也行，见文末常见问题）；
4. **不要**勾选 “Add a README file”“Add .gitignore”“Choose a license”——你本地已经有了，勾了反而会冲突；
5. 点 **Create repository**。

建完页面会显示一堆命令，忽略它，用下面这组。

---

## 第 3 步：把本地仓库连上去并推送

⚠️ 先确认你的 GitHub 用户名真的是 `SarahDeady`（登录 GitHub 后看右上角头像 → Your profile）。**如果不一样，把下面命令里的 `SarahDeady` 换成你的用户名**，同时改 `package.json` 里的 `repository` / `homepage` / `bugs` 三个链接，以及 `README.md` 里的 clone 地址。

```powershell
git remote add origin https://github.com/SarahDeady/dsh-auto-title.git
git branch -M main
git push -u origin main
```

第一次推送会要求登录，二选一：

- **弹窗登录**（推荐）：Windows 一般会弹出 Git Credential Manager 的浏览器授权窗口，点一下就行；
- **用令牌**：GitHub 早就不支持用账号密码推送了。去 <https://github.com/settings/tokens> 生成一个 Personal Access Token（勾 `repo` 权限），推送时用户名填 GitHub 用户名，密码填这个令牌。

推送成功后刷新仓库页面，应该能看到全部文件。

---

## 第 4 步：给仓库化个妆

在仓库首页右侧 **About** 那一栏点齿轮：

- **Description**：`DeepSeek Harness 插件：自动把会话标题提炼成不超过 12 个汉字宽的一行；手动改名后暂停，会话菜单可一键刷新。`
- **Topics** 依次添加：`deepseek-harness`、`dsh-plugin`、`session-title`、`cordis`、`llm`
- 勾上 **Releases**、**Packages**（可选）。

这样别人搜 `dsh-plugin` 或者 `deepseek-harness` 才能找到你。

---

## 第 5 步：发第一个版本（Release）

有了 Release，别人就知道「这东西有个 1.0.0 可用版」。

1. 仓库页面右侧 **Releases** → **Draft a new release**；
2. **Choose a tag** → 输入 `v1.0.0` → 点 **Create new tag: v1.0.0 on publish**；
3. **Release title** 填 `1.0.0`;
4. 说明区里把 `CHANGELOG.md` 中 `## [1.0.0]` 那段复制进去（去掉 `##` 也行）；
5. 点 **Publish release**。

（如果网页上没建 tag，也可以在本地 `git tag v1.0.0 && git push origin v1.0.0`，再回来选这个 tag。）

---

## 第 6 步：以后改代码，怎么发新版

```powershell
# 1. 改代码
# 2. 改 CHANGELOG.md，加一段新的版本
# 3. 改 package.json 里的 "version"（1.0.0 → 1.0.1）
git add .
git commit -m "fix: 修掉了 xxx"
git push

# 4. 打 tag 并推送，然后照第 5 步发 Release
git tag v1.0.1
git push origin v1.0.1
```

版本号怎么取：修 bug 用 `1.0.1`，加功能用 `1.1.0`，不兼容地改配置/行为用 `2.0.0`。

---

## 第 7 步：别人怎么装你的插件

他们不需要 npm，也不需要编译，把你的仓库地址给 Harness 里的 Agent 就行：

> 用 plugin_manager install_bundle 安装 https://github.com/SarahDeady/dsh-auto-title （先 clone 到本地再指向目录）

或者手动：

```powershell
git clone https://github.com/SarahDeady/dsh-auto-title.git C:\plugins\dsh-auto-title
```

然后把 `C:\plugins\dsh-auto-title` 这个目录用 `plugin_manager install_bundle` 装上，重启 Harness。

**装之前提醒一句**：本插件会停用 Harness 内置的 `session-title-llm`（`sessionTitle` 服务只接受一个 provider），这点在 README 里已经写明。

---

## 第 8 步（可选）让它看起来更专业

- **加一张动图**：录 3 秒——打开会话「⋯」菜单 → 点「刷新标题」 → 标题变了。放到 `docs/demo.gif`，README 开头加 `![demo](docs/demo.gif)`。
- **加 CI**（让别人知道测试是绿的）：新建 `.github/workflows/test.yml`：

  ```yaml
  name: test
  on: [push, pull_request]
  jobs:
    test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 22
        - run: npm test
  ```

  （`npm test` 不需要任何依赖，所以没有 `npm install` 那一步。）

---

## 常见问题

**推上去要密码，我输账号密码提示不对？**
GitHub 不支持密码推送。用上文的 Personal Access Token，或让 Git Credential Manager 弹窗登录。

**不小心提交了 node_modules？**

```powershell
git rm -r --cached node_modules
git commit -m "chore: 停止跟踪 node_modules"
```

`.gitignore` 已经在仓库里了，之后不会再进来。

**GitHub 用户名不是 SarahDeady？**
改三处：`package.json` 的 `repository.url` / `homepage` / `bugs.url`，README 里的 `git clone` 地址，以及本文件里的推送地址。

**可以先私有吗？**
可以。但别人要装就得有仓库权限，`plugin_manager` 也没法匿名拉取。想公开再改成 Public 也可以，历史记录不受影响。

**能顺手发到 npm 吗？**
不需要：Harness 是从目录/仓库安装插件的。真要发，`npm publish --access public`（包名 `dsh-auto-title` 如果有人占用，改个名并同步改 `name`、`icon` 和 README）。

**千万别把什么提交上去？**
API key、`.env`、`~/.dsh` 下的 profile 文件、你的会话日志。这个仓库的 `.gitignore` 已经把这些挡在外面了，新增文件时留意一下 `git status` 就够了。

---

## 最终检查清单

- [ ] `npm test` 全绿
- [ ] `git status` 里没有 `node_modules` / 密钥 / 日志
- [ ] GitHub 用户名、README 与 `package.json` 里的链接一致
- [ ] 仓库 About 有描述和 topics
- [ ] 发了 `v1.0.0` Release
- [ ] README 里写了「会停用内置 session-title-llm」这件重要的事
