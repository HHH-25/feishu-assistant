# 飞书 H5 JS SDK

`feishu-h5-js-sdk-1.5.16.js` 下载自飞书官方 CDN：
`https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.16.js`。

官方原版 SHA-256：`E97935944EFA6742AE84018A8E5006CCD040931A2202A90E5E15511FFEA5B810`。
仓库内版本 SHA-256：`4B0ECD56C33F97C858A8D5C0BF9D1876E2305D509903ADFA0BF05180A95F263B`。

仓库内版本只将打包器的两处动态 `Function` 全局对象回退改为 `globalThis`，以满足管理页禁止 `unsafe-eval` 的内容安全策略；其余代码保持官方 1.5.16 版本。升级时需重新核对这两处兼容性改动。

将 SDK 作为同源静态资源提供给飞书工作台页面，避免手机端无法访问外部 CDN 时误报“请在飞书工作台中打开”。更新 SDK 时需从官方地址重新获取并核对来源与哈希。
