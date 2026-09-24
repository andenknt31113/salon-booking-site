const PUBLISHED_MENUS = {
  "categories": [
    {
      "id": "cat0",
      "name": "カット",
      "items": [
        {
          "id": "sm0",
          "name": "ツーブロック、刈り上げ、フェードのメンテナンスカット",
          "price": 4000,
          "priceFrom": true,
          "minutes": 30,
          "note": "当店のご来店から３週以内の方のメンテナンスメニューになりますスキンフェードは＋500になります",
          "image": "assets/style6.jpg"
        },
        {
          "id": "sm1",
          "name": "カットコース",
          "price": 7000,
          "priceFrom": false,
          "minutes": 60,
          "note": "",
          "image": "assets/style6.jpg"
        },
        {
          "id": "sm2",
          "name": "ラグジュアリーカットコース",
          "price": 10000,
          "priceFrom": false,
          "minutes": 90,
          "note": "",
          "image": "assets/style6.jpg"
        },
        {
          "id": "sm3",
          "name": "刈り上げ＋フェードメンテナンス",
          "price": 4000,
          "priceFrom": true,
          "minutes": 30,
          "note": "当店ご来店後３週間以内のメンテナンスメニューになります！",
          "image": "assets/style6.jpg"
        }
      ]
    },
    {
      "id": "cat1",
      "name": "カラー",
      "items": [
        {
          "id": "sm4",
          "name": "カット＋カラー",
          "price": 14900,
          "priceFrom": true,
          "minutes": 120,
          "note": "カットコース＋カラーになります！ラグジュアリーコースにされる場合は＋3300になります！",
          "image": "assets/style2.jpg"
        },
        {
          "id": "sm5",
          "name": "追加カラー",
          "price": 7700,
          "priceFrom": false,
          "minutes": 60,
          "note": "他のメニュー＋カラーをご希望のお客様はこちも選択くださいカラーのみご希望の場合はシャンプーブロー代2200が追加でかかります",
          "image": "assets/style2.jpg"
        }
      ]
    },
    {
      "id": "cat2",
      "name": "パーマ",
      "items": [
        {
          "id": "sm6",
          "name": "カットコース＋パーマ",
          "price": 14900,
          "priceFrom": false,
          "minutes": 120,
          "note": "カットコース＋パーマになります！ラグジュアリーコースにされる場合は＋3300になります",
          "image": "assets/skill2.jpg"
        }
      ]
    },
    {
      "id": "cat3",
      "name": "縮毛矯正",
      "items": [
        {
          "id": "sm7",
          "name": "カット＋縮毛矯正",
          "price": 19800,
          "priceFrom": true,
          "minutes": 120,
          "note": "レングスや髪のダメージによってはプラスケアが必須になる場合もあります。施術前にお伝えいたします。",
          "image": "assets/skill3.jpg"
        }
      ]
    },
    {
      "id": "cat4",
      "name": "トリートメント",
      "items": [
        {
          "id": "sm8",
          "name": "髪質改善トリートメント",
          "price": 7000,
          "priceFrom": true,
          "minutes": 30,
          "note": "",
          "image": ""
        }
      ]
    }
  ],
  "coupons": [
    {
      "id": "sc0",
      "title": "【清潔感と品が続く】men's骨格補正カット＋眉カット",
      "badge": "全員",
      "tags": [
        "カット"
      ],
      "detail": "",
      "price": 6900,
      "priceFrom": false,
      "listPrice": null,
      "minutes": 60,
      "terms": "",
      "image": "assets/style11.jpg"
    },
    {
      "id": "sc1",
      "title": "【全ての身嗜み整える＋最高の体験を】ラグジュアリーカットコース",
      "badge": "全員",
      "tags": [
        "カット",
        "トリートメント",
        "ヘッドスパ"
      ],
      "detail": "",
      "price": 10000,
      "priceFrom": false,
      "listPrice": null,
      "minutes": 60,
      "terms": "",
      "image": "assets/style6.jpg"
    },
    {
      "id": "sc2",
      "title": "【立体感で格が上がる】伸びても自然！白髪ぼかしホワイトメッシュ　men's",
      "badge": "全員",
      "tags": [
        "カット",
        "カラー"
      ],
      "detail": "",
      "price": 19800,
      "priceFrom": false,
      "listPrice": null,
      "minutes": 150,
      "terms": "",
      "image": "assets/skill4.jpg"
    },
    {
      "id": "sc3",
      "title": "【地毛より綺麗】自然に柔らかく仕上げるメンズ縮毛矯正",
      "badge": "全員",
      "tags": [
        "カット",
        "縮毛矯正",
        "トリートメント"
      ],
      "detail": "",
      "price": 22000,
      "priceFrom": false,
      "listPrice": null,
      "minutes": 120,
      "terms": "",
      "image": "assets/skill3.jpg"
    },
    {
      "id": "sc4",
      "title": "【毎朝のセット1分】品よく決まるお悩み解決メンズパーマ",
      "badge": "全員",
      "tags": [
        "カット",
        "パーマ"
      ],
      "detail": "",
      "price": 14500,
      "priceFrom": false,
      "listPrice": null,
      "minutes": 120,
      "terms": "",
      "image": "assets/skill2.jpg"
    },
    {
      "id": "sc5",
      "title": "【彩で見せるワンランク上のお洒落を】カット＋カラー",
      "badge": "全員",
      "tags": [
        "カット",
        "カラー"
      ],
      "detail": "",
      "price": 14500,
      "priceFrom": false,
      "listPrice": null,
      "minutes": 120,
      "terms": "",
      "image": "assets/style2.jpg"
    },
    {
      "id": "sc6",
      "title": "【毎日をストレスフリーに】カット＋ベーシックストレートorアイパー",
      "badge": "全員",
      "tags": [
        "カット",
        "縮毛矯正"
      ],
      "detail": "",
      "price": 19800,
      "priceFrom": false,
      "listPrice": null,
      "minutes": 120,
      "terms": "",
      "image": "assets/style1.jpg"
    },
    {
      "id": "sc7",
      "title": "【ブリーチメニューはこれ！】カット+デザインカラー",
      "badge": "全員",
      "tags": [
        "カット",
        "カラー"
      ],
      "detail": "",
      "price": 0,
      "priceFrom": false,
      "listPrice": null,
      "minutes": 150,
      "terms": "",
      "image": "assets/style5.jpg"
    },
    {
      "id": "sc8",
      "title": "【全ての施術が＋クオリティ】ダメージケアトリートメント",
      "badge": "全員",
      "tags": [
        "トリートメント"
      ],
      "detail": "",
      "price": 3300,
      "priceFrom": false,
      "listPrice": null,
      "minutes": 30,
      "terms": "",
      "image": ""
    },
    {
      "id": "sc9",
      "title": "【髪の膨らみ、立ち上がり１発解決】カット+ダウンパーマ、アップパーマ",
      "badge": "全員",
      "tags": [
        "カット",
        "パーマ"
      ],
      "detail": "",
      "price": 11000,
      "priceFrom": false,
      "listPrice": null,
      "minutes": 90,
      "terms": "",
      "image": "assets/style8.jpg"
    },
    {
      "id": "sc10",
      "title": "【メニューも相談したい方へ】当日一緒に考えましょう！",
      "badge": "全員",
      "tags": [
        "その他"
      ],
      "detail": "",
      "price": 0,
      "priceFrom": false,
      "listPrice": null,
      "minutes": 120,
      "terms": "",
      "image": ""
    },
    {
      "id": "sc11",
      "title": "第１印象確実UP！　眉毛WAX & 眉毛パーマ",
      "badge": "全員",
      "tags": [
        "その他"
      ],
      "detail": "",
      "price": 6600,
      "priceFrom": false,
      "listPrice": null,
      "minutes": 60,
      "terms": "",
      "image": ""
    },
    {
      "id": "sc12",
      "title": "【髪のハリ.ツヤ.コシ全てのチャージ】髪質改善トリートメント",
      "badge": "全員",
      "tags": [
        "トリートメント"
      ],
      "detail": "",
      "price": 7000,
      "priceFrom": false,
      "listPrice": null,
      "minutes": 60,
      "terms": "",
      "image": ""
    },
    {
      "id": "sc13",
      "title": "ヘアセット ※シャンプーブロー込み",
      "badge": "全員",
      "tags": [
        "ヘアセット"
      ],
      "detail": "",
      "price": 4000,
      "priceFrom": false,
      "listPrice": null,
      "minutes": 30,
      "terms": "",
      "image": ""
    }
  ]
};
