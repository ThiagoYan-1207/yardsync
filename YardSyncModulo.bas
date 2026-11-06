Attribute VB_Name = "YardSyncModulo"
Option Explicit
'------------------------------------------------------------------
' YardSync - sincronização com o servidor
'
' Preparação da planilha (.xlsm):
'   1) Crie uma aba chamada  Config  e preencha:
'        B1 = endereço do servidor, sem barra no final
'             (ex.: https://seu-app.up.railway.app)
'        B2 = valor da variável EXCEL_API_KEY configurada no servidor
'   2) Crie uma aba chamada  Veiculos  (a macro preenche sozinha).
'   3) Alt+F11 > Arquivo > Importar arquivo... > escolha este .bas
'   4) Insira um botão na planilha e atribua a macro  SincronizarYardSync
'
' ATENÇÃO (LGPD): a planilha passa a guardar nomes de clientes e a chave
' de acesso. Proteja o arquivo e não o envie por e-mail ou WhatsApp.
'------------------------------------------------------------------
Private Const ABA_CONFIG As String = "Config"
Private Const ABA_DADOS As String = "Veiculos"

Public Sub SincronizarYardSync()
    Dim url As String, chave As String
    Dim http As Object, texto As String
    Dim wsDados As Worksheet

    On Error GoTo Falha

    url = Trim$(CStr(ThisWorkbook.Worksheets(ABA_CONFIG).Range("B1").Value))
    chave = Trim$(CStr(ThisWorkbook.Worksheets(ABA_CONFIG).Range("B2").Value))
    If Len(url) = 0 Or Len(chave) = 0 Then
        MsgBox "Preencha o endereço do servidor (B1) e a chave (B2) na aba " & ABA_CONFIG & ".", vbExclamation, "YardSync"
        Exit Sub
    End If
    If Right$(url, 1) = "/" Then url = Left$(url, Len(url) - 1)

    Application.StatusBar = "YardSync: buscando dados..."
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.Open "GET", url & "/api/exportar.csv", False
    http.setRequestHeader "X-API-Key", chave
    http.setTimeouts 5000, 5000, 15000, 60000
    http.send

    If http.Status = 401 Then
        MsgBox "Chave recusada. Confira a EXCEL_API_KEY no servidor e a célula B2.", vbExclamation, "YardSync"
        GoTo Fim
    ElseIf http.Status <> 200 Then
        MsgBox "O servidor respondeu com erro " & http.Status & ".", vbExclamation, "YardSync"
        GoTo Fim
    End If

    texto = BytesParaTexto(http.responseBody)

    Set wsDados = ThisWorkbook.Worksheets(ABA_DADOS)
    Application.ScreenUpdating = False
    wsDados.Cells.ClearContents
    wsDados.Columns("A:C").NumberFormat = "@"   ' placa, chassi e cliente como texto
    Dim linhas As Long
    linhas = CsvParaPlanilha(texto, wsDados)
    wsDados.Rows(1).Font.Bold = True
    wsDados.Columns.AutoFit

    MsgBox "Sincronizado: " & (linhas - 1) & " veículo(s).", vbInformation, "YardSync"
    GoTo Fim

Falha:
    MsgBox "Não foi possível sincronizar: " & Err.Description, vbCritical, "YardSync"
Fim:
    Application.ScreenUpdating = True
    Application.StatusBar = False
End Sub

' Converte os bytes da resposta (UTF-8) em texto
Private Function BytesParaTexto(ByVal bytes As Variant) As String
    Dim st As Object
    Set st = CreateObject("ADODB.Stream")
    st.Type = 1               ' binário
    st.Open
    st.Write bytes
    st.Position = 0
    st.Type = 2               ' texto
    st.Charset = "utf-8"
    BytesParaTexto = Replace(st.ReadText, ChrW(&HFEFF), "")
    st.Close
End Function

' Lê o CSV (separador ";", campos entre aspas) e escreve nas células.
' Devolve a quantidade de linhas escritas (com o cabeçalho).
Private Function CsvParaPlanilha(ByVal csv As String, ByVal ws As Worksheet) As Long
    Dim i As Long, n As Long, c As String
    Dim linha As Long, coluna As Long
    Dim campo As String, entreAspas As Boolean

    linha = 1: coluna = 1
    n = Len(csv)
    For i = 1 To n
        c = Mid$(csv, i, 1)
        If entreAspas Then
            If c = """" Then
                If i < n And Mid$(csv, i + 1, 1) = """" Then
                    campo = campo & """": i = i + 1
                Else
                    entreAspas = False
                End If
            Else
                campo = campo & c
            End If
        Else
            Select Case c
                Case """"
                    entreAspas = True
                Case ";"
                    ws.Cells(linha, coluna).Value = campo
                    campo = "": coluna = coluna + 1
                Case vbLf
                    ws.Cells(linha, coluna).Value = campo
                    campo = "": coluna = 1: linha = linha + 1
                Case vbCr
                    ' ignora; o fim da linha é tratado no vbLf
                Case Else
                    campo = campo & c
            End Select
        End If
    Next i

    If Len(campo) > 0 Or coluna > 1 Then
        ws.Cells(linha, coluna).Value = campo
        CsvParaPlanilha = linha
    Else
        CsvParaPlanilha = linha - 1
    End If
End Function
