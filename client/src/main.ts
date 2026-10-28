// 前端入口（Vite）：按依赖顺序装配。
// 插件在 app 之前加载，使其 register 在 app 运行时之前完成注册。
import './style.css';
import './hero-ui-core';
import './heroes/miner-ui';
import './heroes/swordsman-ui';
import './app';
