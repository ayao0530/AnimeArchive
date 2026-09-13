/**
 * 内置别名表（《需求与设计文档》4.7.3 预置条目）
 *
 * 每条包含：官方中文名 + 首播年月 + 全部常见别名（中文/繁体/日文/罗马音/英文/缩写）
 */
export interface BuiltinAlias {
  zh: string;
  year: number | null;
  month: number | null;
  aliases: string[];
  bangumiId?: number;
}

export const BUILTIN_ALIASES: BuiltinAlias[] = [
  {
    zh: '孤独摇滚！',
    year: 2022,
    month: 10,
    bangumiId: 328609,
    aliases: ['Bocchi the Rock!', 'ぼっち・ざ・ろっく！', 'ぼっち・ざ・ろっく', 'Bocchi the Rock', '孤独摇滚', 'BOCCHI THE ROCK']
  },
  {
    zh: '这算是哪门子的全能幻想RPG啊！',
    year: 2021,
    month: 4,
    bangumiId: 296259,
    aliases: ['Full Dive', 'Full Dive RPG', 'Full Dive: This Ultimate Next-Gen Full Dive RPG Is Shittier than Real Life!', 'Kyousei Tsukai Anime no Sekai wo Sukutta Koto ni Shimasu']
  },
  {
    zh: 'Re:从零开始的异世界生活',
    year: 2016,
    month: 4,
    bangumiId: 113262,
    aliases: ['Re:Zero kara Hajimeru Isekai Seikatsu', 'Re:Zero', 'ReZero', 'リゼロ', 'Re:ゼロから始める異世界生活', 'リゼロから始める異世界生活']
  },
  {
    zh: '间谍过家家',
    year: 2022,
    month: 4,
    bangumiId: 331767,
    aliases: ['SPY×FAMILY', 'SPY x FAMILY', 'Spy x Family', 'スパイファミリー', '間諜家家酒', '间谍家家酒']
  },
  {
    zh: '鬼灭之刃',
    year: 2019,
    month: 4,
    bangumiId: 227508,
    aliases: ['鬼滅の刃', 'Kimetsu no Yaiba', 'Demon Slayer', 'KnY', '鬼灭']
  },
  {
    zh: '更衣人偶坠入爱河',
    year: 2022,
    month: 1,
    bangumiId: 307625,
    aliases: ['その着せ替え人形は恋をする', 'Sono Bisque Doll wa Koi wo Suru', 'My Dress-Up Darling', '恋上换装娃娃', '替身人偶坠入爱河']
  },
  {
    zh: '关于我转生变成史莱姆这档事',
    year: 2018,
    month: 10,
    bangumiId: 228009,
    aliases: ['転生したらスライムだった件', 'Tensei Shitara Slime Datta Ken', 'Tensei Slime', 'That Time I Got Reincarnated as a Slime', '转生史莱姆']
  },
  {
    zh: '我们无法一起学习',
    year: 2019,
    month: 4,
    bangumiId: 252455,
    aliases: ['Bokutachi wa Benkyou ga Dekinai', 'ぼくたちは勉強ができない', 'Bokutachi wa Benkyou ga Dekinai!', 'We Never Learn']
  },
  {
    zh: '女朋友 and 女朋友',
    year: 2021,
    month: 7,
    bangumiId: 292566,
    aliases: ['Kanojo mo Kanojo', 'カノジョも彼女', 'Girlfriend, Girlfriend', '女朋友和女朋友']
  },
  {
    zh: '进击的巨人 第三季',
    year: 2019,
    month: 4,
    bangumiId: 237227,
    aliases: ['進撃の巨人 Season 3', 'Attack on Titan Season 3', '進撃の巨人 3', 'Shingeki no Kyojin Season 3']
  },
  {
    zh: '进击的巨人 The Final Season',
    year: 2020,
    month: 12,
    bangumiId: 303605,
    aliases: ['進撃の巨人 The Final Season', 'Attack on Titan: The Final Season', 'Shingeki no Kyojin: The Final Season']
  },
  {
    zh: '葬送的芙莉莲',
    year: 2023,
    month: 9,
    bangumiId: 400602,
    aliases: ['葬送のフリーレン', 'Sousou no Frieren', 'Frieren: Beyond Journey\'s End', 'Frieren']
  },
  {
    zh: '我推的孩子',
    year: 2023,
    month: 4,
    bangumiId: 396188,
    aliases: ['【推しの子】', 'Oshi no Ko', 'My Star']
  },
  {
    zh: '咒术回战',
    year: 2020,
    month: 10,
    bangumiId: 296345,
    aliases: ['呪術廻戦', 'Jujutsu Kaisen', 'JJK']
  },
  {
    zh: '我独自升级',
    year: 2024,
    month: 1,
    bangumiId: 407573,
    aliases: ['俺だけレベルアップな件', 'Ore dake Level Up na Ken', 'Solo Leveling']
  },
  {
    zh: '药屋少女的呢喃',
    year: 2023,
    month: 10,
    bangumiId: 311713,
    aliases: ['薬屋のひとりごと', 'Kusuriya no Hitorigoto', 'The Apothecary Diaries', '药屋少女的独语']
  },
  {
    zh: '迷宫饭',
    year: 2024,
    month: 1,
    bangumiId: 405331,
    aliases: ['ダンジョン飯', 'Dungeon Meshi', 'Delicious in Dungeon']
  },
  {
    zh: '赛马娘 Pretty Derby',
    year: 2018,
    month: 4,
    bangumiId: 222396,
    aliases: ['ウマ娘 プリティーダービー', 'Uma Musume Pretty Derby']
  },
  {
    zh: '紫罗兰永恒花园',
    year: 2018,
    month: 1,
    bangumiId: 217795,
    aliases: ['ヴァイオレット・エヴァーガーデン', 'Violet Evergarden']
  },
  {
    zh: '辉夜大小姐想让我告白',
    year: 2019,
    month: 1,
    bangumiId: 234418,
    aliases: ['かぐや様は告らせたい', 'Kaguya-sama wa Kokurasetai', 'Kaguya-sama: Love Is War', '辉夜大小姐想让我告白～天才们的恋爱头脑战～']
  },
  {
    zh: '怕痛的我，把防御力点满就对了',
    year: 2020,
    month: 1,
    bangumiId: 279458,
    aliases: ['痛いのは嫌なので防御力に極振りしたいと思います', 'Itai no wa Iya nano de Bougyoryoku ni Kyokufuri Shitai to Omoimasu', 'Bofuri']
  },
  {
    zh: '无职转生 ～到了异世界就拿出真本事～',
    year: 2021,
    month: 1,
    bangumiId: 289050,
    aliases: ['無職転生', 'Mushoku Tensei', 'Mushoku Tensei: Jobless Reincarnation', '无职转生']
  },
  {
    zh: '摇曳露营△',
    year: 2018,
    month: 1,
    bangumiId: 225305,
    aliases: ['ゆるキャン△', 'Yuru Camp', 'Laid-Back Camp', '摇曳露营']
  },
  {
    zh: '摇曳露营△ 第二季',
    year: 2021,
    month: 1,
    bangumiId: 289150,
    aliases: ['ゆるキャン△ SEASON2', 'ゆるキャン△ 2期', 'Yuru Camp Season 2', 'Yuru Camp S2', 'Yuru Camp S02', 'Laid-Back Camp Season 2', '摇曳露营 第二季']
  },
  {
    zh: '摇曳露营△ 第三季',
    year: 2024,
    month: 4,
    bangumiId: 404352,
    aliases: ['ゆるキャン△ SEASON3', 'Yuru Camp Season 3', 'Yuru Camp S3', 'Laid-Back Camp Season 3']
  },
  {
    zh: '孤独摇滚！ 第二季',
    year: 2026,
    month: 1,
    aliases: ['ぼっち・ざ・ろっく！ 2期', 'Bocchi the Rock! Season 2', 'Bocchi the Rock S2', '孤独摇滚 第二季']
  },
  {
    zh: '鬼灭之刃 无限列车篇',
    year: 2021,
    month: 10,
    bangumiId: 297678,
    aliases: ['鬼滅の刃 無限列車編', 'Kimetsu no Yaiba: Mugen Ressha-hen', 'Demon Slayer: Mugen Train Arc']
  },
  {
    zh: '鬼灭之刃 游郭篇',
    year: 2021,
    month: 12,
    bangumiId: 314304,
    aliases: ['鬼滅の刃 遊郭編', 'Kimetsu no Yaiba: Yuukaku-hen', 'Demon Slayer: Entertainment District Arc']
  },
  {
    zh: '鬼灭之刃 刀匠村篇',
    year: 2023,
    month: 4,
    bangumiId: 384845,
    aliases: ['鬼滅の刃 刀鍛冶の里編', 'Kimetsu no Yaiba: Katanakaji no Sato-hen', 'Demon Slayer: Swordsmith Village Arc']
  },
  {
    zh: '间谍过家家 第二季',
    year: 2023,
    month: 10,
    bangumiId: 400452,
    aliases: ['SPY×FAMILY Season 2', 'SPY x FAMILY Season 2', 'SPY x FAMILY S2', 'スパイファミリー Season 2', '間諜家家酒 第二季']
  },
  {
    zh: '关于我转生变成史莱姆这档事 第二季',
    year: 2021,
    month: 1,
    bangumiId: 282548,
    aliases: ['転生したらスライムだった件 第2期', 'Tensei Shitara Slime Datta Ken 2nd Season', 'That Time I Got Reincarnated as a Slime Season 2', '转生史莱姆 第二季']
  },
  {
    zh: '关于我转生变成史莱姆这档事 第三季',
    year: 2024,
    month: 4,
    bangumiId: 405943,
    aliases: ['転生したらスライムだった件 第3期', 'Tensei Shitara Slime Datta Ken 3rd Season', 'That Time I Got Reincarnated as a Slime Season 3']
  },
  {
    zh: '辉夜大小姐想让我告白 第三季',
    year: 2022,
    month: 4,
    bangumiId: 352827,
    aliases: ['かぐや様は告らせたい -ウルトラロマンティック-', 'Kaguya-sama wa Kokurasetai: Ultra Romantic', 'Kaguya-sama: Love Is War -Ultra Romantic-']
  },
  {
    zh: '进击的巨人 第二季',
    year: 2017,
    month: 4,
    bangumiId: 173264,
    aliases: ['進撃の巨人 Season 2', 'Attack on Titan Season 2', 'Shingeki no Kyojin Season 2']
  },
  {
    zh: '辉夜大小姐想让我告白 第二季',
    year: 2020,
    month: 4,
    bangumiId: 290118,
    aliases: ['かぐや様は告らせたい 第2期', 'Kaguya-sama wa Kokurasetai Season 2', 'Kaguya-sama: Love Is War Season 2']
  },
  {
    zh: '莉可丽丝',
    year: 2022,
    month: 7,
    bangumiId: 343337,
    aliases: ['リコリス・リコイル', 'Lycoris Recoil']
  },
  {
    zh: '电锯人',
    year: 2022,
    month: 10,
    bangumiId: 319119,
    aliases: ['チェンソーマン', 'Chainsaw Man']
  },
  {
    zh: '冰菓',
    year: 2012,
    month: 4,
    bangumiId: 26333,
    aliases: ['氷菓', 'Hyouka', 'Hyou-ka']
  },
  {
    zh: '轻音少女',
    year: 2009,
    month: 4,
    bangumiId: 1399,
    aliases: ['けいおん！', 'K-On!', 'K-ON', '軽音少女']
  },
  {
    zh: 'CLANNAD ～AFTER STORY～',
    year: 2008,
    month: 10,
    bangumiId: 1220,
    aliases: ['CLANNAD AFTER STORY', 'CLANNAD～AFTER STORY～']
  },
  {
    zh: '夏日重现',
    year: 2022,
    month: 4,
    bangumiId: 335701,
    aliases: ['サマータイムレンダ', 'Summer Time Render', 'Summer Time Rendering']
  },
  {
    zh: '间谍教室',
    year: 2023,
    month: 1,
    bangumiId: 361613,
    aliases: ['スパイ教室', 'Spy Classroom']
  },
  {
    zh: '败犬女主太多了！',
    year: 2024,
    month: 7,
    bangumiId: 413948,
    aliases: ['負けヒロインが多すぎる！', 'Make Heroine ga Oosugiru!', 'Makeine']
  },
  {
    zh: '为美好的世界献上祝福！',
    year: 2016,
    month: 1,
    bangumiId: 122084,
    aliases: ['この素晴らしい世界に祝福を！', 'KonoSuba', 'Kono Subarashii Sekai ni Shukufuku wo!', '为美好的世界献上祝福']
  },
  {
    zh: '约会大作战',
    year: 2013,
    month: 4,
    bangumiId: 44284,
    aliases: ['デート・ア・ライブ', 'Date A Live', 'DateALive']
  },
  {
    zh: '刀剑神域',
    year: 2012,
    month: 7,
    bangumiId: 32109,
    aliases: ['ソードアート・オンライン', 'Sword Art Online', 'SAO']
  },
  {
    zh: '魔法少女小圆',
    year: 2011,
    month: 1,
    bangumiId: 21948,
    aliases: ['魔法少女まどか☆マギカ', 'Mahou Shoujo Madoka Magica', 'Puella Magi Madoka Magica']
  },
  {
    zh: '命运石之门',
    year: 2011,
    month: 4,
    bangumiId: 27563,
    aliases: ['STEINS;GATE', 'シュタインズ・ゲート', 'Steins Gate']
  },
  {
    zh: '夏目友人帐',
    year: 2008,
    month: 7,
    bangumiId: 1121,
    aliases: ['夏目友人帳', 'Natsume Yuujinchou', 'Natsume\'s Book of Friends']
  },
  {
    zh: '齐木楠雄的灾难',
    year: 2016,
    month: 7,
    bangumiId: 147150,
    aliases: ['斉木楠雄のΨ難', 'Saiki Kusuo no Ψ-nan', 'The Disastrous Life of Saiki K.']
  },
  {
    zh: '日常',
    year: 2011,
    month: 4,
    bangumiId: 23981,
    aliases: ['日常 (ニチジョウ)', 'Nichijou', 'My Ordinary Life']
  },
  {
    zh: '笨蛋，测验，召唤兽',
    year: 2010,
    month: 1,
    bangumiId: 5231,
    aliases: ['バカとテストと召喚獣', 'Baka to Test to Shoukanjuu']
  },
  {
    zh: '小林家的龙女仆',
    year: 2017,
    month: 1,
    bangumiId: 167599,
    aliases: ['小林さんちのメイドラゴン', 'Kobayashi-san Chi no Maid Dragon', 'Miss Kobayashi\'s Dragon Maid']
  },
  {
    zh: '女友成双',
    year: 2023,
    month: 10,
    bangumiId: 398845,
    aliases: ['カノジョも彼女 Season 2', 'Kanojo mo Kanojo Season 2', '女朋友 and 女朋友 第二季']
  },
  {
    zh: '蓝色监狱',
    year: 2022,
    month: 10,
    bangumiId: 341028,
    aliases: ['ブルーロック', 'Blue Lock']
  },
  {
    zh: '物理魔法使马修',
    year: 2023,
    month: 4,
    bangumiId: 389644,
    aliases: ['マッシュル-MASHLE-', 'Mashle: Magic and Muscles', 'MASHLE']
  },
  {
    zh: '地狱乐',
    year: 2023,
    month: 4,
    bangumiId: 381679,
    aliases: ['地獄楽', 'Jigokuraku', 'Hell\'s Paradise']
  },
  {
    zh: '胆大党',
    year: 2024,
    month: 10,
    bangumiId: 419956,
    aliases: ['ダンダダン', 'Dandadan']
  },
  {
    zh: '蜡笔小新',
    year: 1992,
    month: 4,
    bangumiId: 1697,
    aliases: ['クレヨンしんちゃん', 'Crayon Shin-chan']
  },
  {
    zh: '名侦探柯南',
    year: 1996,
    month: 1,
    bangumiId: 1400,
    aliases: ['名探偵コナン', 'Detective Conan', 'Case Closed']
  },
  {
    zh: '海贼王',
    year: 1999,
    month: 10,
    bangumiId: 975,
    aliases: ['ONE PIECE', 'ワンピース', '航海王']
  },
  {
    zh: '火影忍者',
    year: 2002,
    month: 10,
    bangumiId: 1510,
    aliases: ['NARUTO', 'ナルト', 'NARUTO -ナルト-']
  },
  {
    zh: '死神',
    year: 2004,
    month: 10,
    bangumiId: 1806,
    aliases: ['BLEACH', 'ブリーチ']
  },
  {
    zh: '进击的巨人',
    year: 2013,
    month: 4,
    bangumiId: 46309,
    aliases: ['進撃の巨人', 'Shingeki no Kyojin', 'Attack on Titan']
  },
  {
    zh: '我的英雄学院',
    year: 2016,
    month: 4,
    bangumiId: 125864,
    aliases: ['僕のヒーローアカデミア', 'Boku no Hero Academia', 'My Hero Academia', 'MHA']
  },
  {
    zh: '一拳超人',
    year: 2015,
    month: 10,
    bangumiId: 116410,
    aliases: ['ワンパンマン', 'One Punch Man', 'OPM']
  },
  {
    zh: '东京喰种',
    year: 2014,
    month: 7,
    bangumiId: 78480,
    aliases: ['東京喰種', 'Tokyo Ghoul']
  },
  {
    zh: '紫罗兰永恒花园 剧场版',
    year: 2020,
    month: 9,
    bangumiId: 236748,
    aliases: ['劇場版 ヴァイオレット・エヴァーガーデン', 'Violet Evergarden: The Movie']
  },
  {
    zh: '天气之子',
    year: 2019,
    month: 7,
    bangumiId: 246026,
    aliases: ['天気の子', 'Weathering with You']
  },
  {
    zh: '你的名字。',
    year: 2016,
    month: 8,
    bangumiId: 148178,
    aliases: ['君の名は。', 'Your Name.', 'Your Name']
  },
  {
    zh: '铃芽之旅',
    year: 2022,
    month: 11,
    bangumiId: 345711,
    aliases: ['すずめの戸締まり', 'Suzume', 'Suzume no Tojimari']
  }
];
