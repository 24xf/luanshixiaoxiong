// 英雄插件总入口：
//   1) 导入所有策略类文件（副作用：各自调用 registerStrategy 完成自注册）；
//   2) 透传注册表 API，供引擎/服务器/测试统一从本文件导入。
//
// 新增英雄步骤：
//   a) 在 heroes/ 下新建 <heroId>.js，继承 BaseHeroStrategy，结尾 registerStrategy('<heroId>', XxxStrategy)；
//   b) 在 heroes.json 加一条该英雄的数据；
//   c) 在本文件加一行 `import './<heroId>.js';`
// 全程无需改动任何已有英雄代码或引擎代码。

import './chef.js';
import './vampire.js';
import './miner.js';
import './doctor.js';
import './police.js';
import './farmer.js';
import './carpenter.js';
import './swordsman.js';
import './builder.js';
import './blacksmith.js';
import './merchant.js';
import './gambler.js';

export * from './registry.js';
