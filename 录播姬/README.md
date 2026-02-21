文件名模板：
~~~
video/{{ name}}/{{ "now" | time_zone: "Asia/Shanghai" | format_date: "yyy-MM-dd" }}/{{ "now" | time_zone: "Asia/Shanghai" | format_date: "录播姬_yyy年MM月dd日HH点mm分" }}_{{ title }}_{{ name}}.flv
示例：录播姬/video/高机动持盾军官/2024-12-01/录播姬_2024年12月01日22点13分_暗区最穷_高机动持盾军官.flv
~~~


需要cookies录制原画，格式为：
~~~
SESSDATA=;DedeUserID=;DedeUserID__ckMd5=
~~~
